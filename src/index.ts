import { templateLabels } from "./util/templateLabels";

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string; // ex: "Dedicart <no-reply@dedicart.com.br>"
  EMAIL_REPLY_TO?: string; // opcional
  SITE_DNS?: string; // ex: "dedicart.com.br"
}

const DAYS_STANDARD_TTL = 30; // dias após expiração para standard/basic
const DAYS_PREMIUM_TTL = 365; // dias após expiração para premium (1 ano)
const PROCESS_LIMIT = 200; // limite de intenções processadas por execução (ajuste conforme necessidade)

export default {
  async scheduled(event: any, env: Env, ctx: ExecutionContext) {
    console.log(`Scheduler fired (cron = ${event?.cron ?? "unknown"}) - ${new Date().toISOString()}`);
    try {
      await ensureExpirationNotifiedColumn(env);
      await processExpiredIntentions(env);
      console.log('Scheduled run finished.');
    } catch (err) {
      console.error('Scheduled error:', err);
    }
  },
};

/* ---------- helpers ---------- */

async function ensureExpirationNotifiedColumn(env: Env) {
  try {
    await env.DB.prepare(`SELECT expiration_notified_at FROM intentions LIMIT 1`).all();
  } catch (err) {
    try {
      console.log('Adicionando coluna expiration_notified_at na tabela intentions');
      await env.DB.prepare(`ALTER TABLE intentions ADD COLUMN expiration_notified_at TEXT`).run();
    } catch (e) {
      console.warn('Não foi possível adicionar coluna expiration_notified_at (talvez já exista):', e);
    }
  }
}

function isoNow() {
  return new Date().toISOString();
}

function daysBetween(dateA: Date, dateB: Date) {
  const ms = dateA.getTime() - dateB.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function processExpiredIntentions(env: Env) {
  const nowIso = isoNow();
  const sqlIntentions = `
    SELECT intention_id, email, plan, template_id, expires_in, expiration_notified_at
    FROM intentions
    WHERE status = 'approved' AND expires_in IS NOT NULL AND expires_in <= ?
    ORDER BY expires_in ASC
    LIMIT ${PROCESS_LIMIT}
  `;
  const resIntentions = await env.DB.prepare(sqlIntentions).bind(nowIso).all();
  const intentionsRows = (resIntentions as any).results ?? (resIntentions as any) ?? [];

  if (!intentionsRows || intentionsRows.length === 0) {
    console.log('Nenhuma intention expirada encontrada.');
    return;
  }

  console.log(`Encontradas ${intentionsRows.length} intentions expiradas (limit=${PROCESS_LIMIT}).`);

  for (const row of intentionsRows) {
    try {
      const intentionId: string = row.intention_id ?? row.id;
      const email: string = row.email;
      const plan: string = (row.plan ?? '').toLowerCase();
      const templateId: string = String(row.template_id);
      const expiresAt: string = row.expires_in;
      const expiration_notified_at = row.expiration_notified_at ?? null;

      if (!intentionId || !templateId) {
        console.warn(`Linha inválida (falta intention_id ou template_id):`, row);
        continue;
      }

      if (!/^[a-z0-9_]+$/.test(templateId)) {
        console.warn(`Template id inválido ou perigoso: ${templateId} — pulando intenção ${intentionId}`);
        continue;
      }

      // Buscar form_data na tabela do template (se existir)
      const sqlTemplate = `SELECT form_data FROM ${templateId} WHERE intention_id = ? LIMIT 1`;
      let formRowRes: any;
      try {
        formRowRes = await env.DB.prepare(sqlTemplate).bind(intentionId).all();
      } catch (err) {
        console.error(`Erro ao consultar tabela do template ${templateId} para intention ${intentionId}:`, err);
        // não deletar automaticamente; log e continuar
        continue;
      }

      const formRows = (formRowRes as any).results ?? (formRowRes as any) ?? [];
      const form_data_raw = formRows && formRows[0] ? formRows[0].form_data ?? formRows[0].FORM_DATA : null;

      // calcula dias desde expiração
      const expiresDate = new Date(expiresAt);
      const daysSinceExp = daysBetween(new Date(), expiresDate);

      // envio de notificação se ainda não foi notificado
      if (!expiration_notified_at) {
        try {
          await sendExpirationEmail({
            env,
            to: email,
            intentionId,
            templateId,
            plan,
            expiresAt,
          });
          await env.DB.prepare(`UPDATE intentions SET expiration_notified_at = ? WHERE intention_id = ?`).bind(isoNow(), intentionId).run();
          console.log(`Notificação enviada e marcada para intention ${intentionId}`);
        } catch (err) {
          console.error(`Erro ao enviar email para ${email} (intention ${intentionId}):`, err);
          // não marcamos notified_on para tentar novamente depois
        }
      }

      // decide se deve deletar
      let shouldDelete = false;
      if (plan === 'premium') {
        if (daysSinceExp > DAYS_PREMIUM_TTL) shouldDelete = true; // > 365
      } else {
        if (daysSinceExp > DAYS_STANDARD_TTL) shouldDelete = true; // > 30
      }

      if (!shouldDelete) {
        console.log(`Intention ${intentionId} (plan ${plan}) não atingiu TTL para deleção (expirada há ${daysSinceExp} dias).`);
        continue;
      }

      // Extrair URLs de imagem do form_data (procura recursiva)
      let formDataObj: any = null;
      try {
        formDataObj = typeof form_data_raw === 'string' ? JSON.parse(form_data_raw) : form_data_raw;
      } catch (e) {
        console.warn(`Não foi possível parsear form_data para intention ${intentionId}:`, e);
        formDataObj = null;
      }

      const imageUrls: string[] = [];
      if (formDataObj) findImageUrlsInObject(formDataObj, imageUrls);

      const r2Keys = imageUrls.map(r2KeyFromPublicUrl).filter(Boolean) as string[];

      // Deletar imagens no R2 (se houver)
      let allDeleted = true;
      for (const key of r2Keys) {
        try {
          // env.ASSETS.delete lança se houver problema; se não lança, consideramos sucesso
          await env.ASSETS.delete(key);
          console.log(`R2 delete key=${key} => OK`);
        } catch (err) {
          console.error(`Erro ao deletar R2 key=${key} para intention ${intentionId}:`, err);
          allDeleted = false;
        }
      }

      // Se tudo ok com as imagens, deleta intention (assume cascade no schema)
      if (allDeleted) {
        try {
          await env.DB.prepare(`DELETE FROM intentions WHERE intention_id = ?`).bind(intentionId).run();
          console.log(`Intention ${intentionId} deletada com sucesso (imagens removidas).`);
        } catch (err) {
          console.error(`Erro ao deletar intention ${intentionId}:`, err);
        }
      } else {
        console.warn(`Intention ${intentionId} não deletada: falha ao remover alguma imagem do R2.`);
      }
    } catch (err) {
      console.error('Erro processando intention row:', err);
    }
  } // fim for
}

/** procura por propriedades 'preview' ou strings que parecem ser URLs de imagens dentro do objeto */
function findImageUrlsInObject(obj: any, out: string[]) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) findImageUrlsInObject(item, out);
    return;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k.toLowerCase().includes('preview') && typeof v === 'string' && looksLikeUrl(v)) {
      out.push(v);
    } else if (typeof v === 'string' && (v.includes('/file/') || v.includes('/temp/') || v.includes('/r2/'))) {
      if (looksLikeUrl(v)) out.push(v);
    } else if (typeof v === 'object') {
      findImageUrlsInObject(v, out);
    }
  }
}

function looksLikeUrl(s: string) {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/** Converte URL pública do seu worker de arquivos para a key do R2
 * Exemplo:
 *  https://dedicart-file-worker.dedicart.workers.dev/file/temp/nossa_historia/1754867751216.jpeg
 *  -> temp/nossa_historia/1754867751216.jpeg
 */
function r2KeyFromPublicUrl(publicUrl: string): string | null {
  try {
    const u = new URL(publicUrl);
    const idx = u.pathname.indexOf('/file/');
    if (idx >= 0) {
      return u.pathname.slice(idx + '/file/'.length);
    }
    // fallback: remove leading slash
    if (u.pathname.startsWith('/')) {
      return u.pathname.slice(1);
    }
    return null;
  } catch (e) {
    return null;
  }
}

/* ---------- envio de email via Brevo (Sendinblue) ---------- */
async function sendExpirationEmail(opts: {
  env: Env;
  to: string;
  intentionId: string;
  templateId: string;
  plan: string;
  expiresAt: string;
}) {
  const { env, to, intentionId, templateId, plan, expiresAt } = opts;
  const apiKey = env.BREVO_API_KEY;
  const from = env.EMAIL_FROM;
  const site = env.SITE_DNS ?? 'dedicart.com.br';

  if (!apiKey) {
    console.warn('BREVO_API_KEY não configurado; pulando envio', { to, intentionId });
    return;
  }

  if (!from || typeof from !== 'string') {
    throw new Error('EMAIL_FROM não configurado (ex: "Dedicart <no-reply@dedicart.com.br>").');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error(`Email inválido: ${to}`);
  }

  const renewUrl = `https://${site}/renew?id=${encodeURIComponent(intentionId)}`;
  const expirationDate = new Date(expiresAt).toLocaleDateString('pt-BR');
  const subject = `❌ Sua dedicatória expirou - Renove agora`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
        <h1 style="color: #e74c3c;">Sua dedicatória expirou!</h1>
      </div>
      <div style="padding: 30px;">
        <p>Olá,</p>
        <p>Sua dedicatória no modelo <strong>${templateLabels(templateId)}</strong> expirou em <strong>${expirationDate}</strong>.</p>
        <p style="font-size: 18px;">😢 Não deixe essa mensagem especial desaparecer!</p>
        <p>Renove agora e mantenha sua dedicatória ativa por mais 1 ano.</p>
        <div style="text-align: center; margin: 40px 0;">
          <a href="${renewUrl}" style="display: inline-block; padding: 15px 30px; background-color: #27ae60; color: white; text-decoration: none; font-weight: bold; border-radius: 5px; font-size: 18px;">
            RENOVAR MINHA DEDICATÓRIA
          </a>
        </div>
        <p><strong>Por que renovar?</strong></p>
        <ul>
          <li>Mantenha seu link ativo para compartilhar</li>
          <li>Preserve suas mensagens especiais</li>
        </ul>
        <p>Oferecemos <strong>10% de desconto</strong> para renovações dentro de 48 horas!</p>
        <p>Dúvidas ou problemas? Entre em contato conosco através do e-mail <strong>dedicart.help@gmail.com</strong>.</p>
        <p>Atenciosamente,<br/> <strong>Equipe Dedicart</strong></p>
      </div>
      <div style="background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #6c757d;">
        <p>Este é um e-mail automático. Não responda diretamente.</p>
        <p>© ${new Date().getFullYear()} Dedicart - Todos os direitos reservados</p>
      </div>
    </div>
  `;

  const sender = parseSender(from);
  const payload: any = {
    sender,
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };

  // adiciona replyTo se configurado
  if (env.EMAIL_REPLY_TO) {
    payload.replyTo = { email: env.EMAIL_REPLY_TO };
  }

  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      try { return await res.json(); } catch { return {}; }
    }

    if (res.status === 429 || res.status >= 500) {
      const backoff = 500 * attempt;
      console.warn(`Brevo response ${res.status} — retrying after ${backoff}ms (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    const bodyText = await res.text().catch(() => '');
    throw new Error(`Brevo error ${res.status}: ${bodyText}`);
  }

  throw new Error('Falha no envio de email: máximo de retries atingido');
}

function parseSender(from: string) {
  const m = from.match(/^(.*)<(.+@.+)>$/);
  if (m) {
    return { name: m[1].trim().replace(/(^"|"$)/g, ''), email: m[2].trim() };
  }
  return { name: 'Dedicart', email: from.trim() };
}
