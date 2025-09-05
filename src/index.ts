import sendExpirationEmail from './util/sendExpirationEmail';

export interface Env {
	DB: D1Database;
	R2: R2Bucket;
	BREVO_API_KEY?: string;
	EMAIL_FROM?: string; // ex: "Dedicart <no-reply@dedicart.com.br>"
	EMAIL_REPLY_TO?: string; // opcional
	SITE_DNS?: string; // ex: "dedicart.com.br"
}

const DAYS_STANDARD_TTL = 30;
const DAYS_PREMIUM_TTL = 60;
const PROCESS_LIMIT = 200;

// Controle de paralelismo
const EMAIL_SEND_CONCURRENCY = 5;
const EMAIL_MAX_RETRIES = 3;
const EMAIL_BACKOFF_BASE_MS = 500;

export default {
	async scheduled(event: any, env: Env, ctx: ExecutionContext) {
		console.log(`Scheduler fired (cron = ${event?.cron ?? 'unknown'}) - ${new Date().toISOString()}`);
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

/* ---------- lógica principal ---------- */
async function processExpiredIntentions(env: Env) {
	const nowIso = isoNow();
	const sqlIntentions = `
		SELECT intention_id, email, plan, template_id, expires_in, expiration_notified_at, qr_code
		FROM intentions
		WHERE status = 'approved' AND expires_in IS NOT NULL AND expires_in <= ?
		ORDER BY expires_in ASC
		LIMIT ${PROCESS_LIMIT}
	`;
	const resIntentions = await env.DB.prepare(sqlIntentions).bind(nowIso).all();
	const intentionsRows = (resIntentions as any).results ?? (resIntentions as any) ?? [];

	if (!intentionsRows.length) {
		console.log('Nenhuma intention expirada encontrada.');
		return;
	}

	console.log(`Encontradas ${intentionsRows.length} intentions expiradas (limit=${PROCESS_LIMIT}).`);

	// Cria uma fila de promessas controlando a concorrência
	const queue: (() => Promise<void>)[] = intentionsRows.map((row: any) => () => processSingleIntention(env, row));

	async function runQueue(concurrency: number) {
		const running: Promise<void>[] = [];

		while (queue.length || running.length) {
			while (queue.length && running.length < concurrency) {
				const task = queue.shift()!;
				const p = task().finally(() => {
					const idx = running.indexOf(p);
					if (idx >= 0) running.splice(idx, 1);
				});
				running.push(p);
			}
			await Promise.race(running);
		}
	}

	await runQueue(EMAIL_SEND_CONCURRENCY);
}

async function processSingleIntention(env: Env, row: any) {
	try {
		const intentionId: string = row.intention_id ?? row.id;
		const email: string = row.email;
		const plan: string = (row.plan ?? '').toLowerCase();
		const templateId: string = String(row.template_id);
		const expiresAt: string = row.expires_in;
		const expiration_notified_at = row.expiration_notified_at ?? null;
		const qrPublicUrl: string | null = row.qr_code ?? null;

		if (!intentionId || !templateId) {
			console.warn(`Linha inválida (falta intention_id ou template_id):`, row);
			return;
		}

		if (!/^[a-z0-9_]+$/.test(templateId)) {
			console.warn(`Template id inválido ou perigoso: ${templateId} — pulando intenção ${intentionId}`);
			return;
		}

		// Atualiza status para expired
		try {
			await updateStatusInDB(intentionId, templateId, 'expired', env);
		} catch (err) {
			console.error(`Erro ao atualizar status para expired para intention ${intentionId}:`, err);
			return;
		}

		// Buscar form_data
		const sqlTemplate = `SELECT form_data FROM ${templateId} WHERE intention_id = ? LIMIT 1`;
		let formRowRes: any;
		try {
			formRowRes = await env.DB.prepare(sqlTemplate).bind(intentionId).all();
		} catch (err) {
			console.error(`Erro ao consultar tabela do template ${templateId} para intention ${intentionId}:`, err);
			return;
		}

		const formRows = (formRowRes as any).results ?? (formRowRes as any) ?? [];
		const form_data_raw = formRows && formRows[0] ? formRows[0].form_data ?? formRows[0].FORM_DATA : null;

		// Dias desde expiração
		const expiresDate = new Date(expiresAt);
		const daysSinceExp = daysBetween(new Date(), expiresDate);

		// Envio de email (com retries)
		if (!expiration_notified_at) {
			try {
				await sendEmailWithRetry(env, { to: email, intentionId, templateId, plan, expiresAt });
				await env.DB.prepare(`UPDATE intentions SET expiration_notified_at = ? WHERE intention_id = ?`).bind(isoNow(), intentionId).run();
				console.log(`Notificação enviada e marcada para intention ${intentionId}`);
			} catch (err) {
				console.error(`Erro ao enviar email para ${email} (intention ${intentionId}):`, err);
			}
		}

		// Verifica se deve deletar
		let shouldDelete = false;
		if (plan === 'premium') {
			if (daysSinceExp > DAYS_PREMIUM_TTL) shouldDelete = true;
		} else {
			if (daysSinceExp > DAYS_STANDARD_TTL) shouldDelete = true;
		}

		if (!shouldDelete) {
			console.log(`Intention ${intentionId} (plan ${plan}) não atingiu TTL para deleção (expirada há ${daysSinceExp} dias).`);
			return;
		}

		// Extrair URLs de imagem
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

		if (qrPublicUrl) {
			const qrKey = r2KeyFromPublicUrl(qrPublicUrl);
			if (qrKey && !r2Keys.includes(qrKey)) r2Keys.push(qrKey);
		}

		// Delete imagens em paralelo
		const deleteResults = await Promise.all(
			r2Keys.map(async (keyRaw) => {
				if (!keyRaw) return false;
				const key = keyRaw.startsWith('/') ? keyRaw.slice(1) : keyRaw;
				try {
					await env.R2.delete(key);
					console.log(`R2 delete key=${key} => OK`);
					return true;
				} catch (err) {
					console.error(`Erro ao deletar R2 key=${key} para intention ${intentionId}:`, err);
					return false;
				}
			})
		);

		const allDeleted = deleteResults.every((r) => r);

		if (allDeleted) {
			try {
				await env.DB.prepare(`DELETE FROM intentions WHERE intention_id = ?`).bind(intentionId).run();
				console.log(`Intention ${intentionId} deletada com sucesso (imagens removidas).`);
			} catch (err) {
				console.error(`Erro ao deletar intention ${intentionId}:`, err);
			}
		} else {
			console.warn(`Intention ${intentionId} não deletada: falha ao remover alguma imagem/qr do R2.`);
		}
	} catch (err) {
		console.error('Erro processando intention row:', err);
	}
}

/* ---------- utilitários ---------- */

function updateStatusInDB(intentionId: string, template_id: string, status: string, env: Env) {
	env.DB.prepare(`UPDATE intentions SET status = ? WHERE intention_id = ?`).bind(status, intentionId).run();
	env.DB.prepare(`UPDATE ${template_id} SET status = ? WHERE intention_id = ?`).bind(status, intentionId).run();
	return;
}

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

function r2KeyFromPublicUrl(publicUrl: string): string | null {
	try {
		if (!publicUrl.includes('://') && !publicUrl.startsWith('/')) return publicUrl;
		const u = new URL(publicUrl);
		const idxFile = u.pathname.indexOf('/file/');
		if (idxFile >= 0) return u.pathname.slice(idxFile + '/file/'.length);
		if (u.pathname.startsWith('/file')) return u.pathname.replace(/^\/file\/?/, '');
		if (u.pathname.startsWith('/')) return u.pathname.slice(1);
		return null;
	} catch {
		return null;
	}
}

/* ---------- envio de email com retry e backoff ---------- */
async function sendEmailWithRetry(
	env: Env,
	opts: { to: string; intentionId: string; templateId: string; plan: string; expiresAt: string }
) {
	for (let attempt = 1; attempt <= EMAIL_MAX_RETRIES; attempt++) {
		try {
			await sendExpirationEmail({ env, ...opts });
			return true;
		} catch (err: any) {
			const status = err?.status ?? 0;
			if ((status === 429 || status >= 500) && attempt < EMAIL_MAX_RETRIES) {
				const delay = EMAIL_BACKOFF_BASE_MS * attempt;
				console.warn(`Retrying email ${opts.to} in ${delay}ms (attempt ${attempt})`);
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}
			throw err;
		}
	}
}
