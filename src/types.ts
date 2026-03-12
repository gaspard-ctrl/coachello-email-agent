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
    color:  'text-white',
    bg:     'bg-[#F0024F]',
    border: 'border-[#F0024F]',
    badge:  'bg-[#F0024F] text-white',
  },
  IMPORTANT: {
    label:  'Important',
    color:  'text-white',
    bg:     'bg-[#F768A8]',
    border: 'border-[#F768A8]',
    badge:  'bg-[#F768A8] text-white',
  },
  NORMAL: {
    label:  'Normal',
    color:  'text-[#A5002E]',
    bg:     'bg-[#FBBED7]',
    border: 'border-[#FBBED7]',
    badge:  'bg-[#FBBED7] text-[#A5002E]',
  },
  FAIBLE: {
    label:  'Faible',
    color:  'text-[#C8A0BE]',
    bg:     'bg-[#FDE8F2]',
    border: 'border-[#FDE8F2]',
    badge:  'bg-[#FDE8F2] text-[#C8A0BE]',
  },
};
