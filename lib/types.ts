export type BusinessStatus =
  | 'pending'
  | 'scanning'
  | 'found'
  | 'ready'
  | 'review'
  | 'contacted'
  | 'responded'
  | 'no_inbox'
  | 'bounced'
  | 'invalid'
  | 'duplicate'
  | 'archived';

export type Workspace = {
  id: string;
  name: string;
  api_key?: string | null;
  app_url?: string | null;
  default_audience_category_id?: string | null;
  default_audience_category_name?: string | null;
  dork_settings?: Record<string, unknown> | null;
  extension_settings?: Record<string, unknown> | null;
  email_signature_text?: string | null;
  email_signature_html?: string | null;
  email_logo_url?: string | null;
};

export type Business = {
  id: string;
  workspace_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  domain: string | null;
  category: string | null;
  category_id?: string | null;
  category_name?: string | null;
  location: string | null;
  source: string | null;
  status: BusinessStatus;
  score: number | null;
  normalized_key: string;
  raw: Record<string, unknown> | null;
  reply_state?: string | null;
  last_reply_classification?: string | null;
  last_inbound_at?: string | null;
  last_auto_reply_at?: string | null;
  last_real_reply_at?: string | null;
  social_links?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  email_verification_status?: string | null;
  email_verification_level?: string | null;
  email_verified_at?: string | null;
  email_verification_reason?: string | null;
  email_role_label?: string | null;
  email_mx_hosts?: string[] | null;
};

export type CsvBusinessInput = {
  name: string;
  email: string;
  phone: string;
  website: string;
  domain: string;
  category: string;
  category_id?: string | null;
  category_name?: string | null;
  location: string;
  source: string;
  normalized_key: string;
  raw: Record<string, unknown>;
};


export type CsvInvalidRow = {
  rowNumber: number;
  reason: string;
  raw: Record<string, unknown>;
};

export type DuplicateSource = 'queue' | 'scout_history';

export type ExistingKeyRecord = {
  normalized_key: string;
  source: DuplicateSource;
};

export type ImportResult = {
  uploaded: number;
  inserted: number;
  skippedExistingQueue: number;
  skippedScouted: number;
  skippedTeam?: number;
  skippedFileDuplicates: number;
  invalidRows: CsvInvalidRow[];
  skippedRows: CsvBusinessInput[];
  batchId?: string;
  queuedResearch?: number;
};

export type EmailResearchJob = {
  id: string;
  workspace_id: string;
  business_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  priority: number;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};


export type TemplateAttachment = {
  name: string;
  filename?: string | null;
  public_url: string;
  url?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  storage_path?: string | null;
};

export type MessageTemplate = {
  id: string;
  workspace_id: string;
  name: string;
  subject: string;
  subject_variants?: string[] | null;
  template_type?: 'initial' | 'follow_up' | 'reply' | string | null;
  purpose?: string | null;
  reply_context?: string | null;
  tags?: string[] | null;
  attachments?: TemplateAttachment[] | null;
  raw?: Record<string, unknown> | null;
  category_id?: string | null;
  category_name?: string | null;
  message: string;
  active?: boolean | null;
  created_by: string | null;
  created_at: string;
  updated_at?: string | null;
};

export type ReplyHistory = {
  id: string;
  workspace_id: string;
  business_id?: string | null;
  sent_message_id?: string | null;
  template_id?: string | null;
  gmail_account_id?: string | null;
  batch_id?: string | null;
  from_email?: string | null;
  to_email?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  classification?: string | null;
  is_real_reply?: boolean | null;
  is_auto_reply?: boolean | null;
  is_delivery_failure?: boolean | null;
  is_blocked?: boolean | null;
  is_limit_notice?: boolean | null;
  is_temporary?: boolean | null;
  reply_bucket?: string | null;
  received_at?: string | null;
  gmail_message_id?: string | null;
  gmail_thread_id?: string | null;
  raw?: Record<string, unknown> | null;
};

export type GmailAccount = {
  id: string;
  workspace_id: string;
  email: string;
  display_name: string | null;
  status: string;
  access_token?: string | null;
  refresh_token?: string | null;
  client_id?: string | null;
  expires_at?: string | null;
  daily_limit?: number | null;
  default_run_limit?: number | null;
  account_type?: string | null;
  seed_inbox_enabled?: boolean | null;
  seed_test_address?: string | null;
  spam_risk_status?: string | null;
  last_seed_result?: string | null;
  last_seed_checked_at?: string | null;
  sent_today?: number | null;
  paused_until?: string | null;
  last_error?: string | null;
  is_paused?: boolean | null;
  paused_reason?: string | null;
  pause_kind?: string | null;
  safety_override_until?: string | null;
  safety_override_warning?: string | null;
  safety_override_acknowledged_at?: string | null;
  safety_override_active?: boolean | null;
  pause_issue_key?: string | null;
  pause_issue_count?: number | null;
  pause_issue_window_started_at?: string | null;
  pause_issue_window_ends_at?: string | null;
  pause_issue_last_at?: string | null;
  hard_restriction_active?: boolean | null;
  hard_restricted_until?: string | null;
  hard_restriction_reason?: string | null;
  hard_restriction_count?: number | null;
  connection_status?: string | null;
  connection_verified_at?: string | null;
  connection_error?: string | null;
  raw?: Record<string, unknown> | null;
  signature_enabled?: boolean | null;
  signature_text?: string | null;
  signature_html?: string | null;
  signature_logo_url?: string | null;
  profile_picture_url?: string | null;
  sync_signature_to_gmail?: boolean | null;
  gmail_signature_synced_at?: string | null;
  gmail_signature_sync_error?: string | null;
  created_at: string;
  updated_at?: string | null;
  deployment_cap?: number | null;
  deployment_run_cap?: number | null;
  health_stage?: string | null;
  health_cap?: number | null;
  health_reason?: string | null;
  successful_sends?: number | null;
  lifetime_sent?: number | null;
  permanent_bounces?: number | null;
  temporary_failures?: number | null;
  provider_limit_events?: number | null;
  blocked_events?: number | null;
  real_replies?: number | null;
  last_provider_limit_at?: string | null;
  clean_since?: string | null;
  next_eligible_at?: string | null;
  last_sent_at?: string | null;
  last_health_review_at?: string | null;
  last_stage_change_at?: string | null;
};


export type MessageCategory = {
  id: string;
  workspace_id: string;
  name: string;
  description?: string | null;
  active?: boolean | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type MessageSchedule = {
  id: string;
  workspace_id: string;
  type: 'initial' | 'follow_up';
  followup_segment?: 'all_unanswered' | 'no_reply' | 'auto_reply' | string | null;
  category_id?: string | null;
  audience_category_id?: string | null;
  audience_category_name?: string | null;
  template_id?: string | null;
  target_count?: number | null;
  scheduled_for: string;
  status: 'scheduled' | 'due' | 'running' | 'sent' | 'cancelled' | 'failed' | 'stopped' | 'complete' | 'completed';
  run_kind?: string | null;
  batch_id?: string | null;
  processed_count?: number | null;
  sent_count?: number | null;
  failed_count?: number | null;
  skipped_count?: number | null;
  last_error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  last_heartbeat_at?: string | null;
  stop_requested?: boolean | null;
  stopped_at?: string | null;
  raw?: Record<string, unknown> | null;
  signature_enabled?: boolean | null;
  signature_text?: string | null;
  signature_html?: string | null;
  signature_logo_url?: string | null;
  profile_picture_url?: string | null;
  sync_signature_to_gmail?: boolean | null;
  gmail_signature_synced_at?: string | null;
  gmail_signature_sync_error?: string | null;
  created_at: string;
  updated_at?: string | null;
};


export type SeedInboxTest = {
  id: string;
  workspace_id: string;
  sender_gmail_account_id?: string | null;
  seed_gmail_account_id?: string | null;
  sender_email?: string | null;
  seed_email?: string | null;
  subject?: string | null;
  placement?: 'inbox' | 'spam' | 'promotions' | 'blocked' | 'bounced' | 'not_found' | 'sent_pending_check' | string | null;
  checked_at?: string | null;
  created_at?: string | null;
  raw?: Record<string, unknown> | null;
};
