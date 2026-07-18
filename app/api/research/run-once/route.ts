export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { createClient as createServerSupabaseClient } from '@/lib/supabase-server';
import { chooseBestEmailCandidate, type EmailCandidateDecision } from '@/lib/email-candidate-rules';
import { findEmailsDeepFromWebsite, type DeepWebsiteFinderResult } from '@/lib/website-email-finder';
import { duplicateEmailRisk } from '@/lib/repeated-email-guard';
import { normalizeAutoScoutWebsite } from '@/lib/auto-scout-target';


async function logAutoScoutActivity(supabase: ReturnType<typeof createAdminClient>, workspaceId: string, type: string, message: string, raw: Record<string, unknown> = {}) {
  try {
    await supabase.from('activity_logs').insert({ workspace_id: workspaceId, type, message, raw });
  } catch {
    // Live work logging must never stop the research worker.
  }
}

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const e = error as { message?: string; code?: string; details?: string; hint?: string };
    return [e.message, e.code ? `Code: ${e.code}` : '', e.details ? `Details: ${e.details}` : '', e.hint ? `Hint: ${e.hint}` : ''].filter(Boolean).join(' | ') || JSON.stringify(error);
  } catch { return String(error); }
}

function workerSecretFromRequest(request: NextRequest) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return String(
    request.nextUrl.searchParams.get('secret') ||
    request.nextUrl.searchParams.get('token') ||
    request.headers.get('x-cron-secret') ||
    request.headers.get('x-auto-scout-worker-secret') ||
    request.headers.get('x-worker-secret') ||
    bearer ||
    ''
  );
}

async function signedInMemberCanRun(workspaceId: string) {
  if (!workspaceId) return false;
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return false;
    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id,approved')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .eq('approved', true)
      .limit(1);
    if (memberError) return false;
    return Boolean(member?.length);
  } catch {
    return false;
  }
}

async function authorizeResearchRun(request: NextRequest, workspaceId: string) {
  const configuredSecret = process.env.CRON_SECRET || process.env.AUTO_SCOUT_WORKER_SECRET || process.env.RUN_ALL_WORKER_SECRET || '';
  if (!configuredSecret) return { ok: true };
  const supplied = workerSecretFromRequest(request);
  const userAgent = request.headers.get('user-agent') || '';
  const isVercelCron = userAgent.toLowerCase().includes('vercel-cron');
  if (isVercelCron || supplied === configuredSecret) return { ok: true };
  if (await signedInMemberCanRun(workspaceId)) return { ok: true };
  return { ok: false, error: 'Unauthorized Auto Scout run. Use a valid worker secret or run it while signed in.' };
}

async function resetStaleRunningJobs(supabase: ReturnType<typeof createAdminClient>, workspaceId?: string) {
  const staleSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  let query = supabase
    .from('email_research_jobs')
    .update({ status: 'queued', last_error: null, started_at: null, updated_at: new Date().toISOString() })
    .eq('status', 'running')
    .lt('updated_at', staleSince);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  await query;
}


function sourceEvidenceFromPayload(payload: any): string {
  if (!payload || typeof payload !== 'object') return '';
  const direct = payload.sourceUrl || payload.source_url || payload.foundOn || payload.found_on || payload.contactPage || payload.contact_page || payload.page || payload.evidenceUrl || payload.evidence_url; // Do not treat a generic payload.website as proof that an email was seen on that page.
  if (direct) return String(direct);
  const arrays = [payload.sources, payload.pages, payload.urls, payload.links, payload.evidence];
  for (const item of arrays) {
    if (Array.isArray(item) && item.length) {
      const first = item.find(Boolean);
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object') return String(first.url || first.href || first.page || first.source || '');
    }
  }
  return '';
}

function resultQuality(payload: any): { sourceEvidence: string; quality: string; score: number } {
  const sourceEvidence = sourceEvidenceFromPayload(payload);
  const generated = Boolean(payload?.generated || payload?.guessed || payload?.pattern || String(payload?.method || '').toLowerCase().includes('guess'));
  if (sourceEvidence) return { sourceEvidence, quality: 'source_seen', score: 82 };
  if (generated) return { sourceEvidence, quality: 'generated_only', score: 30 };
  return { sourceEvidence, quality: 'unverified_candidate', score: 45 };
}


function backendMarkedGenerated(payload: any): boolean {
  return Boolean(
    payload?.generated ||
    payload?.guessed ||
    payload?.pattern ||
    payload?.isGuess ||
    String(payload?.method || '').toLowerCase().includes('guess') ||
    String(payload?.source || '').toLowerCase().includes('guess') ||
    String(payload?.reason || '').toLowerCase().includes('generated')
  );
}

function bestEmailDecisionFromPayload(payload: any, business: any) {
  const sourceEvidence = sourceEvidenceFromPayload(payload);
  const generated = backendMarkedGenerated(payload);
  return chooseBestEmailCandidate(payload, business, sourceEvidence, generated);
}

function shouldDeepSearch(decision: EmailCandidateDecision) {
  if (!decision.email) return true;
  if (!decision.valid) return true;
  if (!decision.promote) return true;
  if (decision.quality === 'unverified_candidate') return true;
  return false;
}

function mergeResearchDecision(backendResult: any, backendDecision: EmailCandidateDecision, deepResult: DeepWebsiteFinderResult | null) {
  const deepDecision = deepResult?.decision;
  if (deepDecision?.email && deepDecision.valid && deepDecision.promote) {
    return {
      decision: deepDecision,
      method: 'deep_website_finder',
      payload: { backend: backendResult, backendDecision, deepWebsiteFinder: deepResult },
      reason: deepResult?.reason || deepDecision.reasons.join(' ')
    };
  }
  if (backendDecision.email && backendDecision.valid && backendDecision.promote) {
    return {
      decision: backendDecision,
      method: 'backend_finder',
      payload: { backend: backendResult, backendDecision, deepWebsiteFinder: deepResult },
      reason: backendDecision.reasons.join(' ') || 'Backend returned a promoted email candidate.'
    };
  }
  if (deepDecision?.email && deepDecision.valid) {
    return {
      decision: deepDecision,
      method: 'deep_website_candidate',
      payload: { backend: backendResult, backendDecision, deepWebsiteFinder: deepResult },
      reason: deepResult?.reason || deepDecision.reasons.join(' ')
    };
  }
  if (backendDecision.email && backendDecision.valid) {
    return {
      decision: backendDecision,
      method: 'backend_candidate',
      payload: { backend: backendResult, backendDecision, deepWebsiteFinder: deepResult },
      reason: backendDecision.reasons.join(' ') || 'Backend returned a candidate that needs evidence.'
    };
  }
  return {
    decision: deepDecision || backendDecision,
    method: 'no_trusted_email',
    payload: { backend: backendResult, backendDecision, deepWebsiteFinder: deepResult },
    reason: [backendDecision.reasons.join(' '), deepResult?.reason].filter(Boolean).join(' | ') || 'No trusted email found.'
  };
}


function fetchJsonWithTimeout(url: URL, payload: any, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
    cache: 'no-store'
  }).then(async (response) => {
    const text = await response.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { rawText: text }; }
    if (!response.ok) throw new Error(json?.error || json?.message || `HTTP ${response.status}`);
    return json;
  }).finally(() => clearTimeout(timer));
}


async function runOnce(request: NextRequest) {
  const limit = Math.max(1, Math.min(4, Number(request.nextUrl.searchParams.get('limit') || 2)));
  const concurrency = Math.max(1, Math.min(2, Number(request.nextUrl.searchParams.get('concurrency') || 1)));
  const workspaceId = String(request.nextUrl.searchParams.get('workspaceId') || '').trim();

  const auth = await authorizeResearchRun(request, workspaceId);
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }

  const supabase = createAdminClient();
  await resetStaleRunningJobs(supabase, workspaceId || undefined);

  let jobQuery = supabase
    .from('email_research_jobs')
    .select('id,workspace_id,business_id,attempts,businesses(id,name,email,website,domain,category,location,raw,status)')
    .eq('status', 'queued');
  if (workspaceId) jobQuery = jobQuery.eq('workspace_id', workspaceId);

  const { data: jobs, error: jobError } = await jobQuery
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(limit);
  if (jobError) throw jobError;

  const results: Array<Record<string, unknown>> = [];

  async function processJob(job: any) {
    const business = Array.isArray(job.businesses) ? job.businesses[0] : job.businesses;
    if (!business) {
      await supabase.from('email_research_jobs').update({ status: 'failed', last_error: 'Business not found', finished_at: new Date().toISOString() }).eq('id', job.id);
      results.push({ job: job.id, status: 'failed', error: 'Business not found' });
      return;
    }

    const websiteTarget = normalizeAutoScoutWebsite(business);
    if (!websiteTarget) {
      const result = { method: 'invalid_or_missing_website', reason: 'No usable business website URL. Auto Scout does not search by business name.', website: business.website || business.domain || '' };
      await supabase.from('businesses').update({ status: 'review', raw: { ...(business.raw || {}), backend_email_research: result } }).eq('id', business.id);
      await supabase.from('email_research_jobs').update({ status: 'done', result, finished_at: new Date().toISOString(), last_error: null }).eq('id', job.id);
      results.push({ job: job.id, business: business.id, businessName: business.name, status: 'skipped_no_website', reason: result.reason });
      await logAutoScoutActivity(supabase, job.workspace_id, 'auto_scout_skipped', `Skipped ${business.name || 'business'}: no usable website`, { job_id: job.id, business_id: business.id, website: business.website || business.domain || '', business_name: business.name || '' });
      return;
    }

    const websiteBusiness = { ...business, website: websiteTarget };
    await supabase.from('email_research_jobs').update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempts: (job.attempts || 0) + 1 }).eq('id', job.id);
    await supabase.from('businesses').update({ status: 'scanning', website: business.website || websiteTarget }).eq('id', business.id).neq('status', 'contacted');
    await logAutoScoutActivity(supabase, job.workspace_id, 'auto_scout_checking', `Checking ${business.name || 'business'} website`, { job_id: job.id, business_id: business.id, website: websiteTarget, business_name: business.name || '' });

    try {
      let deepResult: DeepWebsiteFinderResult | null = null;
      const backendResult: any = {};
      const backendError = '';

      // The fresh free build checks the real public website directly from this Vercel deployment.
      await logAutoScoutActivity(supabase, job.workspace_id, 'auto_scout_deep_check', `Checking website pages for ${business.name || 'business'}`, { job_id: job.id, business_id: business.id, website: websiteTarget, business_name: business.name || '' });
      deepResult = await findEmailsDeepFromWebsite(websiteBusiness, { maxPages: 4, timeoutMs: 3500 });
      await logAutoScoutActivity(supabase, job.workspace_id, 'auto_scout_pages_checked', `Checked ${deepResult.pagesChecked} page(s) for ${business.name || 'business'}`, { job_id: job.id, business_id: business.id, website: websiteTarget, business_name: business.name || '', pages_checked: deepResult.pagesChecked, pages_attempted: deepResult.pagesAttempted, source_url: deepResult.sourceUrl || '', email: deepResult.email || '' });


      const backendDecision = bestEmailDecisionFromPayload(backendResult, websiteBusiness);
      const merged = mergeResearchDecision(backendResult, backendDecision, deepResult);
      const decision = merged.decision;
      const email = decision.email;
      const enrichedResult = { ...merged.payload, email, emailDecision: decision, quality: decision.quality, sourceEvidence: decision.sourceEvidence, method: merged.method, backendError };

      if (email && decision.valid && decision.promote) {
        const { data: sameEmailRows, error: sameEmailError } = await supabase
          .from('businesses')
          .select('id,name,email,website,domain,raw')
          .eq('workspace_id', job.workspace_id)
          .ilike('email', email)
          .neq('id', business.id)
          .limit(20);
        if (sameEmailError) throw sameEmailError;
        const duplicateRisk = duplicateEmailRisk(email, websiteBusiness, (sameEmailRows || []) as any[]);
        if (duplicateRisk.risky) {
          const guardedResult = { ...enrichedResult, duplicateEmailGuard: duplicateRisk };
          await supabase.from('email_candidates').upsert({
            workspace_id: job.workspace_id,
            business_id: business.id,
            email,
            source: merged.method,
            score: Math.min(decision.score, 35),
            status: 'rejected_repeated_across_unrelated_businesses',
            raw: guardedResult
          }, { onConflict: 'workspace_id,business_id,email' });
          await supabase.from('businesses').update({ email: null, status: 'review', raw: { ...(business.raw || {}), backend_email_research: guardedResult } }).eq('id', business.id);
          await supabase.from('email_research_jobs').update({ status: 'done', result: guardedResult, finished_at: new Date().toISOString(), last_error: null }).eq('id', job.id);
          results.push({ job: job.id, business: business.id, businessName: business.name, status: 'rejected_repeated_email', email, method: merged.method, quality: 'repeated_email_guard', evidence: decision.sourceEvidence, pagesChecked: deepResult?.pagesChecked || 0, reason: duplicateRisk.reason });
        } else {
          await supabase.from('email_candidates').upsert({
            workspace_id: job.workspace_id,
            business_id: business.id,
            email,
            source: merged.method === 'deep_website_finder' ? `deep_${deepResult?.sourceType || 'website'}` : (decision.sourceEvidence ? 'backend_source_seen' : 'backend_domain_match'),
            score: decision.score,
            status: decision.sourceEvidence ? 'source_seen_candidate' : 'domain_match_candidate',
            raw: enrichedResult
          }, { onConflict: 'workspace_id,business_id,email' });
          await supabase.from('businesses').update({ email, status: 'found', score: decision.score, raw: { ...(business.raw || {}), backend_email_research: enrichedResult } }).eq('id', business.id);
          await supabase.from('email_research_jobs').update({ status: 'done', result: enrichedResult, finished_at: new Date().toISOString(), last_error: null }).eq('id', job.id);
          results.push({ job: job.id, business: business.id, businessName: business.name, status: 'found', email, method: merged.method, quality: decision.quality, evidence: decision.sourceEvidence, pagesChecked: deepResult?.pagesChecked || 0, reason: merged.reason || 'Email passed strict candidate rules.' });
          await logAutoScoutActivity(supabase, job.workspace_id, 'auto_scout_found', `Found ${email} for ${business.name || 'business'}`, { job_id: job.id, business_id: business.id, email, website: business.website || business.domain || '', business_name: business.name || '', pages_checked: deepResult?.pagesChecked || 0, evidence: decision.sourceEvidence || '' });
        }
      } else if (email && decision.valid && !decision.promote) {
        await supabase.from('email_candidates').upsert({
          workspace_id: job.workspace_id,
          business_id: business.id,
          email,
          source: merged.method,
          score: decision.score,
          status: 'needs_evidence',
          raw: enrichedResult
        }, { onConflict: 'workspace_id,business_id,email' });
        await supabase.from('businesses').update({ status: 'review', raw: { ...(business.raw || {}), backend_email_research: enrichedResult } }).eq('id', business.id);
        await supabase.from('email_research_jobs').update({ status: 'done', result: enrichedResult, finished_at: new Date().toISOString(), last_error: null }).eq('id', job.id);
        results.push({ job: job.id, business: business.id, businessName: business.name, status: 'candidate_needs_evidence', email, method: merged.method, quality: decision.quality, evidence: decision.sourceEvidence, pagesChecked: deepResult?.pagesChecked || 0, reason: merged.reason || 'Valid format, but not trusted enough to promote.' });
        await logAutoScoutActivity(supabase, job.workspace_id, 'auto_scout_candidate', `Candidate needs evidence: ${email} for ${business.name || 'business'}`, { job_id: job.id, business_id: business.id, email, website: business.website || business.domain || '', business_name: business.name || '', pages_checked: deepResult?.pagesChecked || 0 });
      } else {
        await supabase.from('businesses').update({ status: 'review', raw: { ...(business.raw || {}), backend_email_research: enrichedResult } }).eq('id', business.id);
        await supabase.from('email_research_jobs').update({ status: 'done', result: enrichedResult, finished_at: new Date().toISOString(), last_error: null }).eq('id', job.id);
        results.push({ job: job.id, business: business.id, businessName: business.name, status: 'no_trusted_email_found', method: merged.method, rejected: decision.rejected, reason: merged.reason, pagesChecked: deepResult?.pagesChecked || 0, pagesAttempted: deepResult?.pagesAttempted || 0 });
        await logAutoScoutActivity(supabase, job.workspace_id, 'auto_scout_no_email', `No trusted email found for ${business.name || 'business'}`, { job_id: job.id, business_id: business.id, website: business.website || business.domain || '', business_name: business.name || '', pages_checked: deepResult?.pagesChecked || 0, reason: merged.reason || '' });
      }
    } catch (error) {
      const attempts = (job.attempts || 0) + 1;
      const nextStatus = attempts >= 3 ? 'failed' : 'queued';
      await supabase.from('email_research_jobs').update({ status: nextStatus, attempts, last_error: errorMessage(error), finished_at: nextStatus === 'failed' ? new Date().toISOString() : null }).eq('id', job.id);
      if (nextStatus === 'failed') await supabase.from('businesses').update({ status: 'review' }).eq('id', business.id);
      results.push({ job: job.id, business: business.id, businessName: business.name, status: nextStatus, error: errorMessage(error) });
      await logAutoScoutActivity(supabase, job.workspace_id, 'auto_scout_failed', `Auto Scout failed for ${business.name || 'business'}: ${errorMessage(error)}`, { job_id: job.id, business_id: business.id, website: business.website || business.domain || '', business_name: business.name || '', error: errorMessage(error) });
    }
  }

  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, (jobs || []).length) }, async () => {
    while (cursor < (jobs || []).length) {
      const index = cursor++;
      await processJob((jobs || [])[index]);
    }
  });
  await Promise.all(runners);

  return NextResponse.json({ success: true, processed: results.length, results });
}

export async function GET(request: NextRequest) {
  try { return await runOnce(request); }
  catch (error) { return NextResponse.json({ success: false, error: errorMessage(error), raw: error }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  try { return await runOnce(request); }
  catch (error) { return NextResponse.json({ success: false, error: errorMessage(error), raw: error }, { status: 500 }); }
}
