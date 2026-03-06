export type Classification = 'URGENT' | 'IMPORTANT' | 'NORMAL' | 'FAIBLE';
export type EmailStatus = 'pending' | 'locked' | 'validated' | 'rejected' | 'sent' | 'draft_saved';

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface Email {
  id: string;
  gmail_id: string;
  thread_id: string;
  from_email: string;
  from_name: string;
  to_email: string;
  subject: string;
  body_text?: string;
  body_preview?: string;
  received_at: string;
  classification: Classification;
  reasoning: string;
  draft_response: string;
  draft_preview?: string;
  status: EmailStatus;
  locked_by: string | null;
  locked_at: string | null;
  validated_at: string | null;
  validated_by: string | null;
  final_response: string | null;
  created_at: string;
  attachments?: EmailAttachment[];
}

export interface Stats {
  classification: Classification;
  status: EmailStatus;
  count: string;
}

export interface Example {
  id: string;
  email_subject: string;
  email_from: string;
  email_body_preview: string;
  ideal_response_preview: string;
  classification: Classification;
  notes: string;
  created_at: string;
}

export interface Rule {
  id: string;
  rule_type: 'sender' | 'keyword' | 'domain' | 'subject_keyword';
  value: string;
  classification: Classification;
  created_at: string;
}

export const CLASSIFICATION_CONFIG: Record<Classification, {
  label: string;
  color: string;
  bg: string;
  border: string;
  badge: string;
}> = {
  URGENT: {
    label:  'Urgent',
    color:  'text-red-700',
    bg:     'bg-red-50',
    border: 'border-red-200',
    badge:  'bg-red-100 text-red-700',
  },
  IMPORTANT: {
    label:  'Important',
    color:  'text-orange-700',
    bg:     'bg-orange-50',
    border: 'border-orange-200',
    badge:  'bg-orange-100 text-orange-700',
  },
  NORMAL: {
    label:  'Normal',
    color:  'text-yellow-700',
    bg:     'bg-yellow-50',
    border: 'border-yellow-200',
    badge:  'bg-yellow-100 text-yellow-700',
  },
  FAIBLE: {
    label:  'Faible',
    color:  'text-green-700',
    bg:     'bg-green-50',
    border: 'border-green-200',
    badge:  'bg-green-100 text-green-700',
  },
};
