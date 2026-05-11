// ============================================================
// Helper partagé : appel à l'API Claude (Anthropic)
// ============================================================
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './_db.js';

export interface ClaudeEmailResult {
  classification: 'URGENT' | 'IMPORTANT' | 'NORMAL' | 'FAIBLE';
  reasoning: string;
  draft_response: string;
}

// ── Tarifs Anthropic (USD par million de tokens) ──
// Cache read = 0.1× input, cache write = 1.25× input
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':           { input: 3,  output: 15 },
  'claude-haiku-4-5-20251001':   { input: 1,  output: 5  },
};

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

// Claude renvoie parfois du JSON avec des retours-ligne bruts dans les valeurs
// (draft_response sur plusieurs lignes). C'est invalide en JSON strict — on
// échappe les caractères de contrôle (< 0x20) à l'intérieur des string literals.
function parseClaudeJson<T = unknown>(raw: string): T {
  const stripped = raw.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\') { out += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
    }
    out += ch;
  }
  return JSON.parse(out) as T;
}

// Cache du modèle configuré (TTL 60s) pour éviter une requête DB par email
let _modelCache: { value: string; expiresAt: number } | null = null;

async function getConfiguredModel(): Promise<string> {
  if (_modelCache && _modelCache.expiresAt > Date.now()) return _modelCache.value;
  try {
    const db = getDb();
    const rows = await db`SELECT value FROM settings WHERE key = 'claude_model' LIMIT 1` as any[];
    const value = rows[0]?.value;
    const model = value && ALLOWED_MODELS.includes(value) ? value : DEFAULT_MODEL;
    _modelCache = { value: model, expiresAt: Date.now() + 60_000 };
    return model;
  } catch {
    return DEFAULT_MODEL;
  }
}

function computeCost(model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): number {
  const p = PRICING[model] ?? { input: 3, output: 15 };
  const inT  = usage.input_tokens || 0;
  const outT = usage.output_tokens || 0;
  const cR   = usage.cache_read_input_tokens || 0;
  const cW   = usage.cache_creation_input_tokens || 0;
  return (
    (inT  * p.input  +
     outT * p.output +
     cR   * p.input * 0.1 +
     cW   * p.input * 1.25) / 1_000_000
  );
}

async function logUsage(opts: {
  functionName: string;
  model: string;
  usage: any;
  emailId?: string;
  emailSubject?: string;
}): Promise<void> {
  try {
    const db = getDb();
    await db`
      CREATE TABLE IF NOT EXISTS claude_usage (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        function_name         VARCHAR(100) NOT NULL,
        model                 VARCHAR(100) NOT NULL,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd              NUMERIC(10, 6) NOT NULL DEFAULT 0,
        email_id              UUID,
        email_subject         TEXT,
        created_at            TIMESTAMP DEFAULT NOW()
      )
    `.catch(() => {});
    const u = opts.usage ?? {};
    const cost = computeCost(opts.model, u);
    await db`
      INSERT INTO claude_usage (
        function_name, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd,
        email_id, email_subject
      ) VALUES (
        ${opts.functionName}, ${opts.model},
        ${u.input_tokens || 0}, ${u.output_tokens || 0},
        ${u.cache_read_input_tokens || 0}, ${u.cache_creation_input_tokens || 0},
        ${cost},
        ${opts.emailId ?? null}, ${opts.emailSubject ?? null}
      )
    `;
  } catch (err) {
    console.error('[claude-usage] Échec log:', err);
  }
}

export async function classifyAndDraftEmail(opts: {
  guide: string;
  examples: Array<{ email_body: string; ideal_response: string; classification: string }>;
  rules: Array<{ rule_type: string; value: string; classification: string }>;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
  context?: string;
}): Promise<ClaudeEmailResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Construire la section règles de classification
  const rulesText = opts.rules.length > 0
    ? opts.rules.map(r => `- Si ${r.rule_type} contient "${r.value}" → ${r.classification}`).join('\n')
    : 'Aucune règle spécifique définie.';

  // Construire la section exemples
  const examplesText = opts.examples.length > 0
    ? opts.examples.slice(0, 8).map((ex, i) =>
        `### Exemple ${i + 1} (${ex.classification})\n**Email reçu:**\n${ex.email_body}\n\n**Réponse idéale:**\n${ex.ideal_response}`
      ).join('\n\n---\n\n')
    : 'Aucun exemple disponible pour l\'instant.';

  const systemPrompt = `Tu es l'assistant email de Coachello, une plateforme de coaching digital.
Tu aides l'équipe à traiter les emails entrants en les classifiant et en rédigeant des brouillons de réponse.

## Guide de réponse de l'entreprise
${opts.guide || 'Utilise un ton professionnel, chaleureux et concis. Signe toujours avec "L\'équipe Coachello".'}

## Règles de classification prioritaires
${rulesText}

## Critères de classification généraux
- **URGENT** : problème bloquant, insatisfaction forte, délai immédiat requis, client stratégique
- **IMPORTANT** : question commerciale, demande de devis, partenariat, suivi de mission en cours
- **NORMAL** : demande d'information, question générale, demande de démo, nouveau contact
- **FAIBLE** : newsletter, spam probable, email automatique, accusé de réception

## Exemples de réponses validées par l'équipe
${examplesText}

## Instruction de réponse
Réponds UNIQUEMENT en JSON valide, sans markdown autour, avec exactement cette structure :
{
  "classification": "URGENT" | "IMPORTANT" | "NORMAL" | "FAIBLE",
  "reasoning": "Explication courte de la classification (1-2 phrases)",
  "draft_response": "Le brouillon de réponse complet, prêt à être envoyé"
}`;

  const userMessage = `Voici l'email à traiter :

**De :** ${opts.fromName} <${opts.fromEmail}>
**Objet :** ${opts.subject}

**Corps du message :**
${opts.body}
${opts.context ? `\n---\n**Instructions spécifiques de l'équipe pour cette réponse :**\n${opts.context}\n---\n` : ''}
Classifie cet email et rédige un brouillon de réponse approprié.`;

  const model = await getConfiguredModel();
  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  await logUsage({
    functionName: 'classifyAndDraftEmail',
    model,
    usage: response.usage,
    emailSubject: opts.subject,
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Réponse Claude inattendue');

  return parseClaudeJson<ClaudeEmailResult>(content.text);
}

// ── Générer des questions de clarification ──────────────────────
export async function askClarifyingQuestions(opts: {
  guide: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
}): Promise<string[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const model = await getConfiguredModel();
  const response = await client.messages.create({
    model,
    max_tokens: 600,
    system: `Tu es l'assistant email de Coachello. Tu dois poser des questions à l'équipe pour pouvoir rédiger une meilleure réponse à un email.
Génère 2 à 3 questions courtes et précises dont tu as besoin pour rédiger une réponse adaptée.
Réponds UNIQUEMENT en JSON valide : { "questions": ["question 1", "question 2", "question 3"] }`,
    messages: [{
      role: 'user',
      content: `Email reçu de ${opts.fromName} <${opts.fromEmail}> — Objet : ${opts.subject}\n\n${opts.body}\n\nQuelles informations manquent pour rédiger une réponse idéale ?`,
    }],
  });

  await logUsage({
    functionName: 'askClarifyingQuestions',
    model,
    usage: response.usage,
    emailSubject: opts.subject,
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Réponse Claude inattendue');
  const json = parseClaudeJson<{ questions: string[] }>(content.text);
  return json.questions;
}

// ── Régénérer le brouillon avec un contexte libre de l'équipe ──
export async function redraftWithContext(opts: {
  guide: string;
  examples: Array<{ email_body: string; ideal_response: string; classification: string }>;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
  context: string;
}): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const examplesText = opts.examples.length > 0
    ? opts.examples.slice(0, 3).map((ex, i) =>
        `Exemple ${i + 1} (${ex.classification}) — Email: ${ex.email_body.slice(0, 150)} → Réponse: ${ex.ideal_response.slice(0, 200)}`
      ).join('\n\n')
    : '';

  const model = await getConfiguredModel();
  const response = await client.messages.create({
    model,
    max_tokens: 800,
    system: `Tu es l'assistant email de Coachello. Rédige un brouillon de réponse complet et prêt à envoyer.
${opts.guide ? `\nGuide : ${opts.guide.slice(0, 800)}` : ''}
${examplesText ? `\nExemples de réponses validées :\n${examplesText}` : ''}
Réponds UNIQUEMENT avec le texte de la réponse, sans introduction ni commentaire.`,
    messages: [{
      role: 'user',
      content: `Email de ${opts.fromName} <${opts.fromEmail}> — Objet : ${opts.subject}\n\n${opts.body.slice(0, 2000)}\n\n---\nInstructions de l'équipe :\n${opts.context}`,
    }],
  });

  await logUsage({
    functionName: 'redraftWithContext',
    model,
    usage: response.usage,
    emailSubject: opts.subject,
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Réponse Claude inattendue');
  return content.text.trim();
}

// ── Composer un nouvel email à partir d'instructions ────────────
export async function composeEmail(opts: {
  guide: string;
  examples: Array<{ email_body: string; ideal_response: string; classification: string }>;
  toEmail: string;
  toName?: string;
  subject?: string;
  instructions: string;
}): Promise<{ subject: string; body: string }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const examplesText = opts.examples.length > 0
    ? opts.examples.slice(0, 5).map((ex, i) =>
        `Exemple ${i + 1} (${ex.classification}) — Réponse: ${ex.ideal_response.slice(0, 250)}`
      ).join('\n\n')
    : '';

  const model = await getConfiguredModel();
  const response = await client.messages.create({
    model,
    max_tokens: 1200,
    system: `Tu es l'assistant email de Coachello, une plateforme de coaching digital.
Tu rédiges des emails professionnels pour l'équipe en suivant le guide de l'entreprise.

## Guide de réponse de l'entreprise
${opts.guide || 'Utilise un ton professionnel, chaleureux et concis. Signe toujours avec "L\'équipe Coachello".'}
${examplesText ? `\n## Exemples de style validés par l'équipe\n${examplesText}` : ''}

## Instructions
Rédige un email complet et prêt à envoyer basé sur les instructions de l'équipe.
Réponds UNIQUEMENT en JSON valide : { "subject": "Objet de l'email", "body": "Corps complet de l'email" }
${opts.subject ? `L'objet est déjà défini : "${opts.subject}". Utilise-le tel quel dans le champ "subject".` : 'Propose un objet approprié.'}`,
    messages: [{
      role: 'user',
      content: `Destinataire : ${opts.toName ? `${opts.toName} <${opts.toEmail}>` : opts.toEmail}
${opts.subject ? `Objet : ${opts.subject}` : ''}

Instructions de l'équipe :
${opts.instructions}`,
    }],
  });

  await logUsage({
    functionName: 'composeEmail',
    model,
    usage: response.usage,
    emailSubject: opts.subject,
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Réponse Claude inattendue');
  return parseClaudeJson<{ subject: string; body: string }>(content.text);
}

// ── Régénérer le brouillon avec les réponses de l'équipe ────────
export async function redraftWithAnswers(opts: {
  guide: string;
  examples: Array<{ email_body: string; ideal_response: string; classification: string }>;
  rules: Array<{ rule_type: string; value: string; classification: string }>;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
  questions: string[];
  answers: string[];
}): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const qaContext = opts.questions.map((q, i) =>
    `Q: ${q}\nR: ${opts.answers[i] ?? '(sans réponse)'}`
  ).join('\n\n');

  const examplesText = opts.examples.length > 0
    ? opts.examples.slice(0, 3).map((ex, i) =>
        `Exemple ${i + 1} (${ex.classification}) — Email: ${ex.email_body.slice(0, 150)} → Réponse: ${ex.ideal_response.slice(0, 200)}`
      ).join('\n\n')
    : '';

  const model = 'claude-haiku-4-5-20251001';
  const response = await client.messages.create({
    model,
    max_tokens: 800,
    system: `Tu es l'assistant email de Coachello. Rédige un brouillon de réponse complet et prêt à envoyer.
${opts.guide ? `\nGuide : ${opts.guide.slice(0, 1000)}` : ''}
${examplesText ? `\nExemples de réponses validées :\n${examplesText}` : ''}
Réponds UNIQUEMENT avec le texte de la réponse, sans introduction ni commentaire.`,
    messages: [{
      role: 'user',
      content: `Email de ${opts.fromName} <${opts.fromEmail}> — Objet : ${opts.subject}\n\n${opts.body}\n\n---\nContexte fourni par l'équipe :\n\n${qaContext}`,
    }],
  });

  await logUsage({
    functionName: 'redraftWithAnswers',
    model,
    usage: response.usage,
    emailSubject: opts.subject,
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Réponse Claude inattendue');
  return content.text.trim();
}
