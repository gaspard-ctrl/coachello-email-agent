export type Classification = 'URGENT' | 'IMPORTANT' | 'NORMAL' | 'FAIBLE';
export type EmailStatus = 'pending' | 'locked' | 'validated' | 'rejected' | 'sent' | 'draft_saved' | 'dismissed';

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
    color:  'text-red-600',
    bg:     'bg-red-50',
    border: 'border-red-100',
    badge:  'bg-red-100 text-red-600',
  },
  IMPORTANT: {
    label:  'Important',
    color:  'text-orange-600',
    bg:     'bg-orange-50',
    border: 'border-orange-100',
    badge:  'bg-orange-100 text-orange-600',
  },
  NORMAL: {
    label:  'Normal',
    color:  'text-blue-600',
    bg:     'bg-blue-50',
    border: 'border-blue-100',
    badge:  'bg-blue-100 text-blue-600',
  },
  FAIBLE: {
    label:  'Faible',
    color:  'text-gray-500',
    bg:     'bg-gray-50',
    border: 'border-gray-200',
    badge:  'bg-gray-100 text-gray-500',
  },
};
