import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { businessIdentityKeys, displayDomain, makeNormalizedKey, normalizeEmail, normalizePhone, normalizeWebsite } from '@/lib/normalize';

function asRows(body: any) {
  const rows = body?.businesses || body?.leads || body?.rows || (body?.lead ? [body.lead] : []);
  return Array.isArray(rows) ? rows : [];
}


const BLOCKED_IMPORT_ROOTS = new Set(['forbes.com','wikipedia.org','medium.com','reddit.com','quora.com','crunchbase.com','bloomberg.com','reuters.com','nytimes.com','bbc.com','cnn.com','cnbc.com','github.com','npmjs.com','shopify.com','themeforest.net','wordpress.org','facebook.com','instagram.com','linkedin.com','youtube.com','tiktok.com','x.com','twitter.com','pinterest.com']);
function rootHost(value: string) {
  const host = displayDomain({ website: value, domain: value }).toLowerCase().replace(/^www\./, '');
  const parts = host.split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}
function blockedImportTarget(email: string, website: string) {
  const emailRoot = email ? rootHost(email.split('@')[1] || '') : '';
  const siteRoot = website ? rootHost(website) : '';
  return Boolean((emailRoot && BLOCKED_IMPORT_ROOTS.has(emailRoot)) || (siteRoot && BLOCKED_IMPORT_ROOTS.has(siteRoot)));
}

function workspaceKeyFrom(request: NextRequest, body: any) {
  return String(request.headers.get('x-scout-workspace-key') || body?.workspaceKey || body?.workspace_key || body?.apiKey || '').trim();
}

async function resolveCategory(admin: ReturnType<typeof createAdminClient>, workspaceId: string, body: any, rows: any[]) {
  let categoryId = String(body?.audienceCategoryId || body?.categoryId || body?.audience_category_id || '').trim();
  let categoryName = String(body?.audienceCategoryName || body?.categoryName || body?.category || body?.audience_category_name || '').trim();
  if (!categoryName) {
    const first = rows.find((r) => r?.audienceCategoryName || r?.categoryName || r?.category || r?.industry || r?.niche);
    categoryName = String(first?.audienceCategoryName || first?.categoryName || first?.category || first?.industry || first?.niche || '').trim();
  }
  if (categoryId) {
    const { data } = await admin.from('message_categories').select('id,name').eq('workspace_id', workspaceId).eq('id', categoryId).maybeSingle();
    if (data?.id) return { categoryId: data.id as string, categoryName: String(data.name || categoryName || '') };
    categoryId = '';
  }
  if (categoryName) {
    const { data: existing } = await admin.from('message_categories').select('id,name').eq('workspace_id', workspaceId).ilike('name', categoryName).maybeSingle();
    if (existing?.id) return { categoryId: existing.id as string, categoryName: String(existing.name || categoryName) };
    const { data: created } = await admin.from('message_categories').insert({ workspace_id: workspaceId, name: categoryName, description: 'Audience category created from extension import.', active: true }).select('id,name').single();
    if (created?.id) return { categoryId: created.id as string, categoryName: String(created.name || categoryName) };
  }
  return { categoryId: null as string | null, categoryName: null as string | null };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const apiKey = workspaceKeyFrom(request, body);
    if (!apiKey) return NextResponse.json({ success: false, ok: false, error: 'Missing x-scout-workspace-key / workspaceKey.' }, { status: 401 });

    const admin = createAdminClient();
    const { data: workspace, error: workspaceError } = await admin
      .from('workspaces')
      .select('id,default_audience_category_id,default_audience_category_name')
      .eq('api_key', apiKey)
      .single();
    if (workspaceError || !workspace) return NextResponse.json({ success: false, ok: false, error: 'Invalid workspace key.' }, { status: 403 });

    const rows = asRows(body);
    if (!rows.length) return NextResponse.json({ success: false, ok: false, error: 'No businesses/leads supplied.' }, { status: 400 });

    const resolvedCategory = await resolveCategory(admin, workspace.id, body, rows);
    const defaultCategoryId = resolvedCategory.categoryId || workspace.default_audience_category_id || null;
    const defaultCategoryName = resolvedCategory.categoryName || workspace.default_audience_category_name || null;

    const payload = rows.map((item: any) => {
      const email = normalizeEmail(item.email || (Array.isArray(item.emails) ? item.emails[0] : ''));
      const website = normalizeWebsite(item.website || item.url || item.profileUrl || item.profile_link);
      const domain = displayDomain({ domain: item.domain, website, email });
      const name = String(item.name || item.businessName || item.business || item.company || '').trim();
      const phone = normalizePhone(item.phone || item.phoneNumber);
      const normalized_key = makeNormalizedKey({ email, domain, website, name, phone });
      if (!normalized_key) return null;
      if (blockedImportTarget(email, website)) return null;
      const rowCategoryName = String(item.audienceCategoryName || item.categoryName || item.category || item.industry || item.niche || defaultCategoryName || '').trim() || null;
      return {
        workspace_id: workspace.id,
        name: name || null,
        email: email || null,
        phone: phone || null,
        website: website || null,
        domain: domain || null,
        category: rowCategoryName,
        category_id: defaultCategoryId,
        category_name: rowCategoryName,
        location: item.location || item.address || item.city || item.country || null,
        source: item.source || body.source || 'extension',
        status: email ? 'ready' : 'pending',
        normalized_key,
        raw: { ...item, extension_ingest: true, received_at: new Date().toISOString(), source_query: item.sourceQuery || body.sourceQuery || null, audienceCategoryId: defaultCategoryId, audienceCategoryName: rowCategoryName }
      };
    }).filter(Boolean) as Array<Record<string, unknown>>;

    if (!payload.length) return NextResponse.json({ success: false, ok: false, error: 'No usable business keys found.' }, { status: 400 });

    const payloadIdentityKeys = new Map<number, string[]>();
    const allIdentityKeys = new Set<string>();
    payload.forEach((row, index) => {
      const keys = businessIdentityKeys(row as any);
      payloadIdentityKeys.set(index, keys);
      for (const key of keys) allIdentityKeys.add(key);
    });
    const teamDuplicateKeys = new Set<string>();
    const identityKeyList = Array.from(allIdentityKeys);
    for (let index = 0; index < identityKeyList.length; index += 1000) {
      const { data: dupes, error: duplicateError } = await admin
        .from('team_scouted_leads')
        .select('normalized_key,first_workspace_id')
        .in('normalized_key', identityKeyList.slice(index, index + 1000));
      if (duplicateError) throw duplicateError;
      for (const row of dupes || []) {
        if (String(row.first_workspace_id || '') && String(row.first_workspace_id) !== String(workspace.id)) {
          teamDuplicateKeys.add(String(row.normalized_key || ''));
        }
      }
    }
    const filteredPayload = payload.filter((row, index) => !(payloadIdentityKeys.get(index) || []).some((key) => teamDuplicateKeys.has(key)));
    const teamDuplicateLeadCount = payload.length - filteredPayload.length;
    if (!filteredPayload.length) {
      await admin.from('app_notifications').insert({
        workspace_id: workspace.id,
        type: 'team_duplicate_removed',
        title: 'Team duplicate leads removed',
        message: `${teamDuplicateLeadCount.toLocaleString()} lead${teamDuplicateLeadCount === 1 ? '' : 's'} already scouted by a Scout user and removed from this extension import.`,
        entity_type: 'extension_import',
        entity_id: null,
        raw: { teamDuplicatesRemoved: teamDuplicateLeadCount, source: body.source || 'extension' }
      });
      return NextResponse.json({ success: true, ok: true, received: rows.length, inserted: 0, added: 0, skippedOrDuplicate: teamDuplicateLeadCount, duplicates: teamDuplicateLeadCount, teamDuplicatesRemoved: teamDuplicateLeadCount, directEmails: 0, emailsFound: 0, queuedAutoScout: 0, audienceCategoryId: defaultCategoryId, audienceCategoryName: defaultCategoryName });
    }

    const { data: inserted, error } = await admin.from('businesses').upsert(filteredPayload, {
      onConflict: 'workspace_id,normalized_key',
      ignoreDuplicates: true
    }).select('id,email,website');
    if (error) return NextResponse.json({ success: false, ok: false, error: error.message }, { status: 400 });

    const insertedRows = inserted || [];
    const directEmailRows = insertedRows.filter((row: any) => row.email);
    const websiteOnlyRows = insertedRows.filter((row: any) => !row.email && row.website);

    if (directEmailRows.length) {
      await admin.from('email_candidates').upsert(directEmailRows.map((row: any) => ({
        workspace_id: workspace.id,
        business_id: row.id,
        email: row.email,
        source: 'extension_direct_email',
        score: 82,
        status: 'extension_candidate',
        raw: { extension_ingest: true, audienceCategoryId: defaultCategoryId, audienceCategoryName: defaultCategoryName }
      })), { onConflict: 'workspace_id,business_id,email', ignoreDuplicates: true });
    }

    let queuedAutoScout = 0;
    if (websiteOnlyRows.length) {
      const { data: jobs, error: jobsError } = await admin
        .from('email_research_jobs')
        .upsert(websiteOnlyRows.map((row: any) => ({
          workspace_id: workspace.id,
          business_id: row.id,
          status: 'queued',
          attempts: 0,
          priority: 145,
          requested_by: null
        })), { onConflict: 'workspace_id,business_id', ignoreDuplicates: true })
        .select('id');
      if (!jobsError) queuedAutoScout = jobs?.length || 0;
    }

    if (teamDuplicateLeadCount > 0) {
      await admin.from('app_notifications').insert({
        workspace_id: workspace.id,
        type: 'team_duplicate_removed',
        title: 'Team duplicate leads removed',
        message: `${teamDuplicateLeadCount.toLocaleString()} lead${teamDuplicateLeadCount === 1 ? '' : 's'} already scouted by a Scout user and removed from this extension import.`,
        entity_type: 'extension_import',
        entity_id: null,
        raw: { teamDuplicatesRemoved: teamDuplicateLeadCount, source: body.source || 'extension' }
      });
    }

    await admin.from('activity_logs').insert({
      workspace_id: workspace.id,
      type: 'extension_ingest',
      message: `Extension imported ${insertedRows.length} lead(s)${defaultCategoryName ? ` for ${defaultCategoryName}` : ''}, direct emails ${directEmailRows.length}, queued ${queuedAutoScout} website(s) for Auto Scout.${teamDuplicateLeadCount ? ` Removed ${teamDuplicateLeadCount.toLocaleString()} already scouted by team.` : ''}`,
      raw: { received: rows.length, inserted: insertedRows.length, directEmails: directEmailRows.length, queuedAutoScout, teamDuplicatesRemoved: teamDuplicateLeadCount, source: body.source || 'extension', audienceCategoryId: defaultCategoryId, audienceCategoryName: defaultCategoryName }
    });

    return NextResponse.json({
      success: true,
      ok: true,
      received: rows.length,
      inserted: insertedRows.length,
      added: insertedRows.length,
      skippedOrDuplicate: Math.max(0, filteredPayload.length - insertedRows.length) + teamDuplicateLeadCount,
      duplicates: Math.max(0, filteredPayload.length - insertedRows.length) + teamDuplicateLeadCount,
      teamDuplicatesRemoved: teamDuplicateLeadCount,
      directEmails: directEmailRows.length,
      emailsFound: directEmailRows.length,
      queuedAutoScout,
      audienceCategoryId: defaultCategoryId,
      audienceCategoryName: defaultCategoryName
    });
  } catch (error) {
    return NextResponse.json({ success: false, ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
