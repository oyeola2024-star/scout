'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { csvColumnsLookDifferent, parseCsvText } from '@/lib/csv';
import { errorMessage, fetchJson, isAuthError, isTransientError, withRetry } from '@/lib/app-error';
import { Business, CsvBusinessInput, CsvInvalidRow, ImportResult, MessageCategory, Workspace } from '@/lib/types';

const MAX_IMPORT_ROWS = 100000;
const TARGET_IMPORT_CHUNK_ROWS = 1000;
const MIN_IMPORT_CHUNK_ROWS = 100;
const MAX_IMPORT_CHUNK_BYTES = 1_250_000;
const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;
const ACTIVE_QUEUE_STATUSES = ['pending', 'scanning', 'found', 'ready', 'review'];

type ImportPhase = 'idle' | 'reading' | 'ready' | 'checking' | 'importing' | 'done' | 'failed';
type TargetWarning = { activeCount: number; previousHeaders: string[]; newHeaders: string[] } | null;
type ImportChunkResult = { inserted_count: number; skipped_queue_count: number; skipped_history_count: number; skipped_team_count?: number; skipped_keys?: string[] | null };
type AudienceCategorySelection = { id: string; name: string };

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function uniqueRows(rows: CsvBusinessInput[]) {
  const map = new Map<string, CsvBusinessInput>();
  const duplicateRows: CsvBusinessInput[] = [];
  for (const row of rows) {
    if (!row.normalized_key) continue;
    if (map.has(row.normalized_key)) duplicateRows.push(row);
    else map.set(row.normalized_key, row);
  }
  return { rows: [...map.values()], duplicateRows };
}

function formatImportError(error: unknown) {
  return errorMessage(error, 'Unknown import error.');
}

function csvEscape(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadRawRows(name: string, rows: Array<{ raw: Record<string, unknown> }>) {
  if (!rows.length) return;
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row.raw || {}).forEach((key) => set.add(key));
    return set;
  }, new Set<string>()));
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row.raw[h])).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadBusinessRows(name: string, businesses: Business[]) {
  if (!businesses.length) return;
  const headers = ['name', 'email', 'phone', 'website', 'domain', 'category', 'location', 'source', 'status', 'score', 'normalized_key', 'created_at', 'updated_at'];
  const lines = [headers.map(csvEscape).join(',')];
  for (const b of businesses) lines.push(headers.map((h) => csvEscape((b as unknown as Record<string, unknown>)[h])).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadInvalidRows(name: string, rows: CsvInvalidRow[]) {
  if (!rows.length) return;
  const rawHeaders = Array.from(rows.reduce((set, row) => {
    Object.keys(row.raw || {}).forEach((key) => set.add(key));
    return set;
  }, new Set<string>()));
  const headers = ['rowNumber', 'reason', ...rawHeaders];
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push([row.rowNumber, row.reason, ...rawHeaders.map((h) => row.raw[h])].map(csvEscape).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toRpcRows(rows: CsvBusinessInput[]) {
  return rows.map((row) => ({
    name: row.name || null,
    email: row.email || null,
    phone: row.phone || null,
    website: row.website || null,
    domain: row.domain || null,
    category: row.category || null,
    location: row.location || null,
    source: row.source || 'csv_upload',
    normalized_key: row.normalized_key,
    raw: row.raw || {}
  }));
}


function estimateRpcRowBytes(row: CsvBusinessInput): number {
  try {
    return new TextEncoder().encode(JSON.stringify(toRpcRows([row])[0])).length + 2;
  } catch {
    return 2048;
  }
}

function makeImportChunks(rows: CsvBusinessInput[]): CsvBusinessInput[][] {
  const parts: CsvBusinessInput[][] = [];
  let current: CsvBusinessInput[] = [];
  let currentBytes = 2;

  for (const row of rows) {
    const rowBytes = estimateRpcRowBytes(row);
    const exceedsRows = current.length >= TARGET_IMPORT_CHUNK_ROWS;
    const exceedsBytes = current.length > 0 && currentBytes + rowBytes > MAX_IMPORT_CHUNK_BYTES;
    if (exceedsRows || exceedsBytes) {
      parts.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }

  if (current.length) parts.push(current);
  return parts;
}

function shouldSplitImportChunk(error: unknown): boolean {
  if (isAuthError(error)) return false;
  const message = formatImportError(error).toLowerCase();
  if ([
    'permission denied',
    'do not belong to this workspace',
    'does not exist',
    'could not find the function',
    'schema cache',
    'invalid input syntax',
    'violates check constraint'
  ].some((part) => message.includes(part))) return false;

  return isTransientError(error) || [
    'payload',
    'request entity too large',
    'body exceeded',
    'statement timeout',
    'resource limit',
    'memory',
    'connection'
  ].some((part) => message.includes(part));
}

export default function UploadClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const [categories, setCategories] = useState<MessageCategory[]>([]);
  const [audienceCategoryId, setAudienceCategoryId] = useState(workspace.default_audience_category_id || '');
  const [newAudienceCategory, setNewAudienceCategory] = useState(workspace.default_audience_category_name || '');
  const [rows, setRows] = useState<CsvBusinessInput[]>([]);
  const [invalidRows, setInvalidRows] = useState<CsvInvalidRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [progress, setProgress] = useState('Choose a CSV file. Rows with emails go to Ready for Message; rows without emails stay Pending for Auto Scout.');
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [importing, setImporting] = useState(false);
  const [enqueueResearch, setEnqueueResearch] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [targetWarning, setTargetWarning] = useState<TargetWarning>(null);
  const [allowDifferentTarget, setAllowDifferentTarget] = useState(false);

  const selectedAudienceCategory = categories.find((c) => c.id === audienceCategoryId) || null;

  async function loadCategories() {
    const { data, error } = await supabase
      .from('message_categories')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    setCategories((data || []) as MessageCategory[]);
  }

  useEffect(() => {
    loadCategories().catch((error) => setErrors([formatImportError(error)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function ensureAudienceCategory() {
    if (audienceCategoryId) return { id: audienceCategoryId, name: selectedAudienceCategory?.name || newAudienceCategory.trim() || '' };
    const name = newAudienceCategory.trim();
    if (!name) return { id: '', name: '' };
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('message_categories')
      .upsert({ workspace_id: workspace.id, name, description: 'Audience category created during CSV upload.', active: true, created_by: user?.id || null }, { onConflict: 'workspace_id,name' })
      .select('*')
      .single();
    if (error) throw error;
    setAudienceCategoryId(data.id);
    setNewAudienceCategory(data.name || name);
    await loadCategories();
    return { id: data.id as string, name: String(data.name || name) };
  }

  async function checkTargetMismatch(nextHeaders: string[]) {
    setTargetWarning(null);
    setAllowDifferentTarget(false);
    const { count, error: countError } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace.id)
      .in('status', ACTIVE_QUEUE_STATUSES);
    if (countError) throw countError;
    const activeCount = count || 0;
    if (!activeCount) return;

    const { data, error } = await supabase
      .from('import_batches')
      .select('headers')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const previousHeaders = Array.isArray(data?.headers) ? data.headers : [];
    if (csvColumnsLookDifferent(previousHeaders, nextHeaders)) setTargetWarning({ activeCount, previousHeaders, newHeaders: nextHeaders });
  }


  async function invokeImportRpc(
    part: CsvBusinessInput[],
    batchId: string,
    category: AudienceCategorySelection,
    onRetry: (message: string) => void
  ): Promise<ImportChunkResult> {
    let refreshedSession = false;

    return withRetry(async () => {
      const { data, error } = await supabase.rpc('import_businesses_chunk_with_category', {
        target_workspace: workspace.id,
        target_batch_id: batchId,
        input_rows: toRpcRows(part),
        target_category_id: category.id || null,
        target_category_name: category.name || null
      });

      if (error && isAuthError(error) && !refreshedSession) {
        refreshedSession = true;
        const { error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) throw refreshError;
        const retry = await supabase.rpc('import_businesses_chunk_with_category', {
          target_workspace: workspace.id,
          target_batch_id: batchId,
          input_rows: toRpcRows(part),
          target_category_id: category.id || null,
          target_category_name: category.name || null
        });
        if (retry.error) throw retry.error;
        const refreshedItem = ((retry.data || []) as ImportChunkResult[])[0];
        if (!refreshedItem) throw new Error('Import server returned no result for this chunk.');
        return refreshedItem;
      }

      if (error) throw error;
      const item = ((data || []) as ImportChunkResult[])[0];
      if (!item) throw new Error('Import server returned no result for this chunk.');
      return item;
    }, {
      retries: 3,
      baseDelayMs: 650,
      maxDelayMs: 6000,
      onRetry: (error, attempt, delayMs) => {
        onRetry(`Temporary upload interruption. Retrying safely (${attempt}/3) in ${(delayMs / 1000).toFixed(1)}s: ${formatImportError(error)}`);
      }
    });
  }

  async function importChunkWithRecovery(
    part: CsvBusinessInput[],
    batchId: string,
    category: AudienceCategorySelection,
    onLeafComplete: (rowCount: number) => void,
    onRetry: (message: string) => void
  ): Promise<ImportChunkResult[]> {
    try {
      const item = await invokeImportRpc(part, batchId, category, onRetry);
      onLeafComplete(part.length);
      return [item];
    } catch (error) {
      if (part.length <= MIN_IMPORT_CHUNK_ROWS || !shouldSplitImportChunk(error)) throw error;
      const middle = Math.ceil(part.length / 2);
      onRetry(`A ${part.length.toLocaleString()}-row chunk was too heavy or interrupted. Scout is splitting it into smaller safe chunks without restarting the import.`);
      const left = await importChunkWithRecovery(part.slice(0, middle), batchId, category, onLeafComplete, onRetry);
      const right = await importChunkWithRecovery(part.slice(middle), batchId, category, onLeafComplete, onRetry);
      return [...left, ...right];
    }
  }

  async function fetchBatchImportedKeys(batchId: string): Promise<Set<string>> {
    const keys = new Set<string>();
    const pageSize = 1000;
    for (let from = 0; from < MAX_IMPORT_ROWS; from += pageSize) {
      const { data, error } = await supabase
        .from('businesses')
        .select('normalized_key')
        .eq('workspace_id', workspace.id)
        .eq('import_batch_id', batchId)
        .range(from, from + pageSize - 1);
      if (error) throw error;
      for (const row of data || []) {
        const key = String((row as { normalized_key?: string }).normalized_key || '').trim();
        if (key) keys.add(key);
      }
      if (!data || data.length < pageSize) break;
    }
    return keys;
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setResult(null);
    setErrors([]);
    setWarnings([]);
    setRows([]);
    setInvalidRows([]);
    setHeaders([]);
    setPercent(0);
    setPhase('idle');
    if (!file) return;

    setFileName(file.name);
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setPhase('failed');
      setProgress(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The safe browser limit is ${Math.round(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MB. Split it into smaller CSV files while keeping each file under 100,000 usable rows.`);
      setErrors([`File is too large for a reliable browser upload (${(file.size / 1024 / 1024).toFixed(1)} MB).`]);
      event.target.value = '';
      return;
    }

    setPhase('reading');
    setProgress('Reading CSV locally. The app only renders a 25-row preview, so large files should not freeze the page...');
    try {
      const text = await file.text();
      const parsed = await parseCsvText(text);
      setHeaders(parsed.headers);
      setInvalidRows(parsed.invalidRows);
      setErrors(parsed.errors);

      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        setRows(parsed.rows.slice(0, 100));
        setPhase('failed');
        setProgress(`File has ${parsed.rows.length.toLocaleString()} usable rows. Limit is ${MAX_IMPORT_ROWS.toLocaleString()} rows per import.`);
        setErrors((current) => [`Import limit is ${MAX_IMPORT_ROWS.toLocaleString()} usable rows per file. This file has ${parsed.rows.length.toLocaleString()}.`, ...current]);
        return;
      }

      try {
        await checkTargetMismatch(parsed.headers);
      } catch (warningError) {
        console.warn('Target comparison skipped because Supabase was temporarily unavailable:', warningError);
        setWarnings((current) => [...current, 'The target comparison could not be completed, but the CSV is ready and can still be imported.']);
      }
      setRows(parsed.rows);
      setPhase('ready');
      const emailCount = parsed.rows.filter((row) => row.email).length;
      const websiteCount = parsed.rows.filter((row) => row.website || row.domain).length;
      setProgress(`Preview ready: ${parsed.rows.length.toLocaleString()} usable row(s). ${emailCount.toLocaleString()} will go to Ready for Message. ${(parsed.rows.length - emailCount).toLocaleString()} without email will stay Pending for Auto Scout. ${websiteCount.toLocaleString()} have website/domain. ${parsed.invalidRows.length.toLocaleString()} invalid row(s).`);
    } catch (error) {
      setPhase('failed');
      setErrors([formatImportError(error)]);
      setProgress('File could not be read. Confirm it is a valid CSV and try again.');
    } finally {
      event.target.value = '';
    }
  }

  async function enqueueImportedResearch(batchId: string) {
    const json = await fetchJson<{ success?: boolean; error?: string; enqueued?: number }>('/api/research/enqueue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.id, limit: 10000, importBatchId: batchId })
    }, { timeoutMs: 45000, retries: 2 });
    if (!json.success) throw new Error(json.error || 'Could not enqueue background email research.');
    return Number(json.enqueued || 0);
  }

  async function importRows() {
    if (!rows.length || importing) return;
    if (targetWarning && !allowDifferentTarget) {
      setErrors(['This looks like a different target list while unfinished businesses still exist. Tick “Import anyway” if you want to continue.']);
      return;
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      setErrors([`Import limit is ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split the file before importing.`]);
      return;
    }

    setImporting(true);
    setResult(null);
    setErrors([]);
    setWarnings([]);
    setPercent(0);

    const startedAt = performance.now();
    const unique = uniqueRows(rows);
    const deduped = unique.rows;
    const duplicateRows = unique.duplicateRows;
    let batchId = '';
    let processed = 0;
    let insertedFromRpc = 0;
    let skippedQueueFromRpc = 0;
    let skippedHistoryFromRpc = 0;
    let skippedTeamFromRpc = 0;
    const skippedKeysFromRpc = new Set<string>();

    try {
      setPhase('checking');
      setProgress(`Preparing ${deduped.length.toLocaleString()} unique business(es). Removed ${duplicateRows.length.toLocaleString()} duplicate row(s) inside the file.`);

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) throw userError || new Error('Not signed in.');

      const category = await ensureAudienceCategory();

      const requestedBatchId = crypto.randomUUID();
      const batch = await withRetry(async () => {
        const response = await supabase
          .from('import_batches')
          .upsert({
            id: requestedBatchId,
            workspace_id: workspace.id,
            file_name: fileName || 'csv_upload.csv',
            row_count: rows.length,
            inserted_count: 0,
            skipped_count: duplicateRows.length + invalidRows.length,
            headers,
            category_id: category.id || null,
            category_name: category.name || null,
            source_mode: 'csv_upload',
            created_by: userData.user.id
          }, { onConflict: 'id' })
          .select('id')
          .single();
        if (response.error) throw response.error;
        return response.data;
      }, { retries: 2 });

      batchId = String(batch.id);
      const parts = makeImportChunks(deduped);
      setPhase('importing');
      setProgress(`Starting safe cloud import in ${parts.length.toLocaleString()} chunk(s). Scout automatically retries temporary failures and splits heavy chunks.`);

      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const results = await importChunkWithRecovery(
          part,
          batchId,
          category,
          (rowCount) => {
            processed += rowCount;
            setPercent(Math.min(96, Math.round((processed / Math.max(deduped.length, 1)) * 96)));
            setProgress(`Safe cloud import: ${processed.toLocaleString()} / ${deduped.length.toLocaleString()} row(s). Chunk ${Math.min(index + 1, parts.length).toLocaleString()} of ${parts.length.toLocaleString()}.`);
          },
          (message) => setProgress(message)
        );

        for (const item of results) {
          insertedFromRpc += Number(item.inserted_count || 0);
          skippedQueueFromRpc += Number(item.skipped_queue_count || 0);
          skippedHistoryFromRpc += Number(item.skipped_history_count || 0);
          skippedTeamFromRpc += Number(item.skipped_team_count || 0);
          for (const key of item.skipped_keys || []) skippedKeysFromRpc.add(key);
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      setProgress('Verifying the saved rows so a retried network request cannot produce an incorrect total...');
      let importedKeys: Set<string> | null = null;
      try {
        importedKeys = await withRetry(() => fetchBatchImportedKeys(batchId), { retries: 2 });
      } catch (verificationError) {
        console.warn('Import verification query failed:', verificationError);
        setWarnings((current) => [...current, 'The upload completed, but Scout could not run the final verification count. The imported records are still protected by database deduplication.']);
      }

      const inserted = importedKeys ? importedKeys.size : insertedFromRpc;
      const skippedRows = importedKeys
        ? deduped.filter((row) => !importedKeys!.has(row.normalized_key))
        : deduped.filter((row) => skippedKeysFromRpc.has(row.normalized_key));
      const uniqueSkipped = Math.max(0, deduped.length - inserted);
      const skippedTeam = Math.min(uniqueSkipped, skippedTeamFromRpc);
      const skippedScouted = Math.min(Math.max(0, uniqueSkipped - skippedTeam), skippedHistoryFromRpc);
      const skippedExistingQueue = Math.max(0, uniqueSkipped - skippedTeam - skippedScouted);
      let queuedResearch = 0;

      if (enqueueResearch && inserted > 0) {
        setProgress('Import saved. Queueing background email research jobs...');
        try {
          queuedResearch = await enqueueImportedResearch(batchId);
        } catch (researchError) {
          console.warn('Optional research queue step failed after successful import:', researchError);
          setWarnings((current) => [...current, `Businesses were imported successfully, but background research was not queued: ${formatImportError(researchError)}`]);
        }
      }

      const skippedTotal = skippedRows.length + duplicateRows.length + invalidRows.length;
      const { error: batchUpdateError } = await supabase
        .from('import_batches')
        .update({ inserted_count: inserted, skipped_count: skippedTotal })
        .eq('id', batchId);
      if (batchUpdateError) {
        console.warn('Import batch summary update failed:', batchUpdateError);
        setWarnings((current) => [...current, 'The leads were saved, but the import-history summary could not be updated.']);
      }

      if (skippedTeam > 0) {
        const { error: notificationError } = await supabase.from('app_notifications').insert({
          workspace_id: workspace.id,
          type: 'team_duplicate_removed',
          title: 'Team duplicate leads removed',
          message: `${skippedTeam.toLocaleString()} lead${skippedTeam === 1 ? '' : 's'} already scouted by a team member and removed from this upload.`,
          entity_type: 'import_batch',
          entity_id: batchId,
          raw: { batchId, skippedTeam, removedFromUpload: true }
        });
        if (notificationError) console.warn('Team duplicate notification could not be created:', notificationError);
      }

      setResult({ uploaded: rows.length, inserted, skippedExistingQueue, skippedScouted, skippedTeam, skippedFileDuplicates: duplicateRows.length, invalidRows, skippedRows, batchId, queuedResearch });
      const seconds = Math.max(0.1, (performance.now() - startedAt) / 1000);
      setPercent(100);
      setPhase('done');
      setProgress(`Done in ${seconds.toFixed(1)}s. Imported ${inserted.toLocaleString()} new business(es), skipped ${skippedTotal.toLocaleString()}.${skippedTeam ? ` ${skippedTeam.toLocaleString()} were already scouted by a team member and removed.` : ''} Rows with email were saved as Ready; no-email rows were saved as Pending for Auto Scout.${queuedResearch ? ` Queued ${queuedResearch.toLocaleString()} research job(s).` : ''}`);
    } catch (error) {
      const message = formatImportError(error);
      console.error('Scout reliable import failed:', error);

      let partialInserted = insertedFromRpc;
      if (batchId) {
        try {
          const partialKeys = await fetchBatchImportedKeys(batchId);
          partialInserted = partialKeys.size;
          await supabase
            .from('import_batches')
            .update({ inserted_count: partialInserted, skipped_count: duplicateRows.length + invalidRows.length })
            .eq('id', batchId);
        } catch (partialError) {
          console.warn('Could not verify partial import after failure:', partialError);
        }
      }

      setErrors([message]);
      setPhase('failed');
      setPercent(Math.min(96, Math.round((processed / Math.max(deduped.length, 1)) * 96)));
      setProgress(partialInserted > 0
        ? `The connection stopped after ${partialInserted.toLocaleString()} row(s) were safely saved. Select the same CSV and import again; Scout's database deduplication will continue without creating duplicate leads.`
        : 'The import did not complete. Scout retried and reduced the chunk size before stopping. Check the error below and try the same file again.');
    } finally {
      setImporting(false);
    }
  }

  async function fetchPendingNoEmailBusinesses(maxRows = 50000) {
    const all: Business[] = [];
    const pageSize = 1000;
    for (let from = 0; from < maxRows; from += pageSize) {
      const { data, error } = await supabase
        .from('businesses')
        .select('*')
        .eq('workspace_id', workspace.id)
        .in('status', ['pending', 'scanning', 'found', 'review'])
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const batch = ((data || []) as Business[]).filter((b) => !String(b.email || '').trim());
      all.push(...batch);
      if (!data || data.length < pageSize) break;
    }
    return all;
  }

  async function exportPendingNoEmailForScout() {
    setImporting(true);
    setErrors([]);
    try {
      const pending = await fetchPendingNoEmailBusinesses();
      if (!pending.length) {
        setProgress('No pending no-email businesses found to export for Auto Scout.');
        return;
      }
      downloadBusinessRows('scout-pending-no-email-for-auto-scout.csv', pending);
      setProgress(`Exported ${pending.length.toLocaleString()} pending no-email business(es) for Auto Scout.`);
    } catch (error) {
      setErrors([formatImportError(error)]);
    } finally {
      setImporting(false);
    }
  }

  async function deletePendingNoEmailBusinesses() {
    const ok = confirm('Delete all Pending/Scanning/Found/Review businesses that have no email? Export them first if you still need them for Auto Scout.');
    if (!ok) return;
    setImporting(true);
    setErrors([]);
    try {
      const { data, error } = await supabase.rpc('delete_pending_no_email_businesses', { target_workspace: workspace.id });
      if (error) throw error;
      setProgress(`Deleted ${(Number(data) || 0).toLocaleString()} pending no-email business(es).`);
    } catch (error) {
      setErrors([formatImportError(error)]);
    } finally {
      setImporting(false);
    }
  }

  async function repairEmailRouting() {
    setImporting(true);
    setErrors([]);
    try {
      const { data, error } = await supabase.rpc('mark_ready_emails_and_pending_no_email', { target_workspace: workspace.id });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      setProgress(`Repaired routing. Ready with email: ${Number(row?.ready_count || 0).toLocaleString()}. Pending without email: ${Number(row?.pending_count || 0).toLocaleString()}.`);
    } catch (error) {
      setErrors([formatImportError(error)]);
    } finally {
      setImporting(false);
    }
  }

  const detectedEmailCount = rows.filter((row) => row.email).length;
  const detectedWebsiteCount = rows.filter((row) => row.website || row.domain).length;

  return (
    <div className="stack">
      <div className="card" style={{ padding: 18 }}>
        <label className="label">Upload CSV</label>
        <input className="input" type="file" accept=".csv,text/csv" onChange={onFile} />
        <div className="grid grid-2" style={{ marginTop: 12 }}>
          <div>
            <label className="label">Audience category for this upload</label>
            <select className="select" value={audienceCategoryId} onChange={(event) => { setAudienceCategoryId(event.target.value); const cat = categories.find((c) => c.id === event.target.value); if (cat) setNewAudienceCategory(cat.name); }}>
              <option value="">New / uncategorized</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">New category name</label>
            <input className="input" value={newAudienceCategory} onChange={(event) => { setNewAudienceCategory(event.target.value); if (audienceCategoryId) setAudienceCategoryId(''); }} placeholder="Airtable service, Marketing, Shopify audit" />
          </div>
        </div>
        <p className="muted">Limit: 100,000 usable rows. Import divides rows clearly: emails → Ready for Message; no email → Pending for Auto Scout; duplicates are skipped/exportable; invalid rows are downloadable. It scans email1/email2/email3/validatedEmail columns and every cell.</p>
        <div className={phase === 'failed' ? 'error' : phase === 'done' ? 'success' : 'notice'}>{progress}</div>
        <div className="progress-track" aria-label="Import progress"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>

        {targetWarning ? (
          <div className="error">
            <strong>Different target warning:</strong> You still have {targetWarning.activeCount.toLocaleString()} unfinished business(es) in the queue, and this file looks like a different target list. Finish/send the current batch first, or tick the confirmation below.
            <label className="checkbox-row" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={allowDifferentTarget} onChange={(event) => setAllowDifferentTarget(event.target.checked)} />
              Import anyway — I understand this may mix different campaigns.
            </label>
          </div>
        ) : null}

        <label className="checkbox-row">
          <input type="checkbox" checked={enqueueResearch} onChange={(event) => setEnqueueResearch(event.target.checked)} />
          Queue background email research after import
        </label>

        <div className="actions">
          <button className="btn" disabled={!rows.length || importing || rows.length > MAX_IMPORT_ROWS} onClick={importRows}>{importing ? 'Importing...' : `Import ${rows.length.toLocaleString()} business(es)`}</button>
          <button className="btn secondary" type="button" disabled={importing} onClick={repairEmailRouting}>Repair: Email → Ready / No Email → Pending</button>
          <button className="btn secondary" type="button" disabled={importing} onClick={exportPendingNoEmailForScout}>Export Pending No-Email for Auto Scout</button>
          <button className="btn danger" type="button" disabled={importing} onClick={deletePendingNoEmailBusinesses}>Delete Pending No-Email</button>
          {invalidRows.length ? <button className="btn secondary" type="button" onClick={() => downloadInvalidRows('scout-invalid-rows.csv', invalidRows)}>Download invalid rows</button> : null}
          {result?.skippedRows.length ? <button className="btn secondary" type="button" onClick={() => downloadRawRows('scout-skipped-duplicates.csv', result.skippedRows)}>Download skipped duplicates</button> : null}
        </div>
      </div>

      {warnings.length ? <div className="notice"><strong>Completed with note:</strong><br />{warnings.map((warning, index) => <div key={index}>{warning}</div>)}</div> : null}
      {errors.length ? <div className="error"><strong>Import stopped:</strong><br />{errors.map((error, index) => <div key={index}>{error}</div>)}</div> : null}

      {result ? (
        <div className="grid grid-4">
          <div className="card kpi"><div className="title">Uploaded</div><div className="num">{result.uploaded.toLocaleString()}</div></div>
          <div className="card kpi"><div className="title">Imported</div><div className="num">{result.inserted.toLocaleString()}</div></div>
          <div className="card kpi"><div className="title">Already In Queue</div><div className="num">{result.skippedExistingQueue.toLocaleString()}</div></div>
          <div className="card kpi"><div className="title">Already In This Account</div><div className="num">{result.skippedScouted.toLocaleString()}</div></div>
          <div className="card kpi"><div className="title">Team Already Scouted</div><div className="num">{Number((result as any).skippedTeam || 0).toLocaleString()}</div></div>
          <div className="card kpi"><div className="title">File Duplicates</div><div className="num">{result.skippedFileDuplicates.toLocaleString()}</div></div>
          <div className="card kpi"><div className="title">Invalid Rows</div><div className="num">{result.invalidRows.length.toLocaleString()}</div></div>
          <div className="card kpi"><div className="title">Research Jobs</div><div className="num">{(result.queuedResearch || 0).toLocaleString()}</div></div>
          <div className="card kpi"><div className="title">Batch ID</div><div className="num" style={{ fontSize: 12, wordBreak: 'break-all' }}>{result.batchId || '-'}</div></div>
        </div>
      ) : null}

      {rows.length ? (
        <div className="card" style={{ padding: 18 }}>
          <h3>Preview</h3>
          <p className="muted">Showing first 25 rows only. Full file detected: {detectedEmailCount.toLocaleString()} email row(s), {detectedWebsiteCount.toLocaleString()} website/domain row(s). If the first 25 rows show blank email but this count is above 0, the emails are later in the file.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Website</th><th>Category</th><th>Location</th><th>Dedupe Key</th></tr></thead>
              <tbody>
                {rows.slice(0, 25).map((row, index) => (
                  <tr key={`${row.normalized_key}-${index}`}>
                    <td>{row.name || '-'}</td><td>{row.email || '-'}</td><td>{row.website || row.domain || '-'}</td><td>{row.category || '-'}</td><td>{row.location || '-'}</td><td>{row.normalized_key}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
