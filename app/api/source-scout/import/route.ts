import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { parseSourceScoutText, type SourceScoutMode } from '@/lib/source-scout';
import { businessIdentityKeys } from '@/lib/normalize';

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const e = error as { message?: string; code?: string; details?: string; hint?: string };
    return [e.message, e.code ? `Code: ${e.code}` : '', e.details ? `Details: ${e.details}` : '', e.hint ? `Hint: ${e.hint}` : ''].filter(Boolean).join(' | ') || JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ success: false, error: userError?.message || 'Not signed in.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || '');
    const text = String(body.text || '');
    const niche = String(body.niche || '');
    const location = String(body.location || '');
    const country = String(body.country || '');
    const sourceMode = String(body.sourceMode || 'mixed') as SourceScoutMode;
    const audienceCategoryId = String(body.audienceCategoryId || body.categoryId || '').trim() || null;
    const audienceCategoryName = String(body.audienceCategoryName || body.categoryName || body.category || '').trim() || null;
    const enqueueWebsiteAutoScout = body.enqueueWebsiteAutoScout !== false;
    const directEmailsReady = body.directEmailsReady !== false;
    const previewOnly = Boolean(body.previewOnly);

    if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });
    if (!text.trim()) return NextResponse.json({ success: false, error: 'Paste Google/Bing/directory results, websites, emails, or extension text first.' }, { status: 400 });

    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id,approved')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .limit(1);
    if (memberError) throw memberError;
    if (!member?.length) return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });

    const parsed = parseSourceScoutText({ text, niche, location, country, sourceMode });
    if (previewOnly) return NextResponse.json({ success: true, previewOnly: true, ...parsed });

    const leadIdentityKeys = new Map<string, string[]>();
    const allIdentityKeys = new Set<string>();
    for (const lead of parsed.leads) {
      const keys = businessIdentityKeys(lead as any);
      leadIdentityKeys.set(lead.normalized_key, keys);
      for (const key of keys) allIdentityKeys.add(key);
    }
    const teamDuplicateKeys = new Set<string>();
    const identityKeyList = Array.from(allIdentityKeys);
    for (let index = 0; index < identityKeyList.length; index += 1000) {
      const { data: teamDupes, error: teamError } = await supabase.rpc('team_duplicate_keys', {
        input_keys: identityKeyList.slice(index, index + 1000),
        target_workspace: workspaceId
      });
      if (teamError) throw teamError;
      for (const row of teamDupes || []) teamDuplicateKeys.add(String((row as any).normalized_key || ''));
    }

    const isTeamDuplicate = (lead: (typeof parsed.leads)[number]) =>
      (leadIdentityKeys.get(lead.normalized_key) || []).some((key) => teamDuplicateKeys.has(key));
    const filteredLeads = parsed.leads.filter((lead) => !isTeamDuplicate(lead));
    const teamDuplicateLeadCount = parsed.leads.length - filteredLeads.length;

    const { data: batch, error: batchError } = await supabase
      .from('import_batches')
      .insert({
        workspace_id: workspaceId,
        file_name: `source-scout-${sourceMode}-${new Date().toISOString()}`,
        row_count: filteredLeads.length,
        inserted_count: 0,
        skipped_count: teamDuplicateLeadCount,
        headers: ['name', 'email', 'website', 'phone', 'category', 'location', 'source'],
        category_id: audienceCategoryId,
        category_name: audienceCategoryName,
        source_mode: sourceMode,
        created_by: user.id
      })
      .select('id')
      .single();
    if (batchError) throw batchError;

    const payload = filteredLeads.map((lead) => ({
      workspace_id: workspaceId,
      import_batch_id: batch.id,
      name: lead.name || null,
      email: lead.email || null,
      phone: lead.phone || null,
      website: lead.website || null,
      domain: lead.domain || null,
      category: audienceCategoryName || lead.category || null,
      category_id: audienceCategoryId,
      category_name: audienceCategoryName || lead.category || null,
      location: lead.location || null,
      source: lead.source,
      status: lead.email && directEmailsReady ? 'ready' : 'pending',
      score: lead.email ? Math.max(70, lead.confidence) : null,
      normalized_key: lead.normalized_key,
      raw: lead.raw,
      created_by: user.id
    }));

    let inserted: Array<{ id: string; email?: string | null; website?: string | null; normalized_key?: string | null }> = [];
    if (payload.length) {
      const { data, error } = await supabase
        .from('businesses')
        .upsert(payload, { onConflict: 'workspace_id,normalized_key', ignoreDuplicates: true })
        .select('id,email,website,normalized_key');
      if (error) throw error;
      inserted = (data || []) as typeof inserted;
    }

    const directEmailRows = inserted.filter((row) => row.email);
    if (directEmailRows.length) {
      const emailPayload = directEmailRows.map((row) => ({
        workspace_id: workspaceId,
        business_id: row.id,
        email: row.email,
        source: `source_scout_${sourceMode}`,
        score: 78,
        status: 'direct_source_candidate',
        raw: { sourceMode, audienceCategoryId, audienceCategoryName, importBatchId: batch.id, sourceScout: true }
      }));
      const { error } = await supabase
        .from('email_candidates')
        .upsert(emailPayload, { onConflict: 'workspace_id,business_id,email', ignoreDuplicates: true });
      if (error) throw error;
    }

    let queuedAutoScout = 0;
    if (enqueueWebsiteAutoScout) {
      const websiteRows = inserted.filter((row) => !row.email && row.website);
      if (websiteRows.length) {
        const jobPayload = websiteRows.map((row) => ({
          workspace_id: workspaceId,
          business_id: row.id,
          status: 'queued',
          attempts: 0,
          priority: 120,
          requested_by: user.id
        }));
        const { data: jobs, error } = await supabase
          .from('email_research_jobs')
          .upsert(jobPayload, { onConflict: 'workspace_id,business_id', ignoreDuplicates: true })
          .select('id');
        if (error) throw error;
        queuedAutoScout = jobs?.length || 0;
      }
    }

    await supabase
      .from('import_batches')
      .update({ inserted_count: inserted.length, skipped_count: Math.max(0, payload.length - inserted.length) + teamDuplicateLeadCount })
      .eq('id', batch.id);

    await supabase.from('activity_logs').insert({
      workspace_id: workspaceId,
      type: 'source_scout_import',
      message: `Source Scout imported ${inserted.length} lead(s), direct emails ${directEmailRows.length}, queued ${queuedAutoScout} website(s) for Auto Scout.`,
      raw: { sourceMode, niche, location, country, parsedCounts: { leads: parsed.leads.length, directEmailCount: parsed.directEmailCount, websiteOnlyCount: parsed.websiteOnlyCount, teamDuplicatesRemoved: teamDuplicateLeadCount }, importBatchId: batch.id },
      created_by: user.id
    });

    return NextResponse.json({
      success: true,
      importBatchId: batch.id,
      parsed: parsed.leads.length,
      inserted: inserted.length,
      skippedOrDuplicate: Math.max(0, payload.length - inserted.length) + teamDuplicateLeadCount,
      teamDuplicatesRemoved: teamDuplicateLeadCount,
      directEmails: directEmailRows.length,
      websiteOnly: inserted.filter((row) => !row.email && row.website).length,
      queuedAutoScout,
      rejected: parsed.rejected,
      sample: filteredLeads.slice(0, 50),
      dorks: parsed.dorks
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error), raw: error }, { status: 500 });
  }
}
