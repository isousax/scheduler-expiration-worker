import { templateLabels } from './util/templateLabels';

export interface Env {
	DB: D1Database;
	R2: R2Bucket;
	BREVO_API_KEY?: string;
	EMAIL_FROM?: string; // ex: "Dedicart <no-reply@dedicart.com.br>"
	EMAIL_REPLY_TO?: string; // opcional
	SITE_DNS?: string; // ex: "dedicart.com.br"
}

const DAYS_STANDARD_TTL = 30; // dias após expiração para standard/basic
const DAYS_PREMIUM_TTL = 60; // dias após expiração para premium (2 meses)
const PROCESS_LIMIT = 200; // limite de intenções processadas por execução (ajuste conforme necessidade)

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
			const qrPublicUrl: string | null = row.qr_code ?? null;

			if (!intentionId || !templateId) {
				console.warn(`Linha inválida (falta intention_id ou template_id):`, row);
				continue;
			}

			if (!/^[a-z0-9_]+$/.test(templateId)) {
				console.warn(`Template id inválido ou perigoso: ${templateId} — pulando intenção ${intentionId}`);
				continue;
			}

			//Altera status da dedicatória para expirado
			try {
				await updateStatusInDB(intentionId, templateId, 'expired', env);
			} catch (err) {
				console.error(`Erro ao atualizar status para expired para intention ${intentionId}:`, err);
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

			// Adiciona qr_code (se existir) à lista de keys a deletar (evita duplicata)
			if (qrPublicUrl) {
				const qrKey = r2KeyFromPublicUrl(qrPublicUrl);
				if (qrKey) {
					if (!r2Keys.includes(qrKey)) r2Keys.push(qrKey);
				} else {
					console.warn(`Não foi possível extrair chave R2 do qr_code para intention ${intentionId}: ${qrPublicUrl}`);
				}
			}

			// Deletar imagens no R2 (se houver)
			let allDeleted = true;
			for (const keyRaw of r2Keys) {
				if (!keyRaw) continue;
				const key = keyRaw.startsWith('/') ? keyRaw.slice(1) : keyRaw; // normaliza
				try {
					await env.R2.delete(key);
					console.log(`R2 delete key=${key} => OK`);
				} catch (err) {
					console.error(`Erro ao deletar R2 key=${key} para intention ${intentionId}:`, err);
					allDeleted = false;
				}
			}

			// Se tudo ok com as imagens (incluindo qr), deleta intention (assume cascade no schema)
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
	} // fim for
}

function updateStatusInDB(intentionId: string, template_id: string, status: string, env: Env) {
	env.DB.prepare(`UPDATE intentions SET status = ? WHERE intention_id = ?`).bind(status, intentionId).run();
	env.DB.prepare(`UPDATE ${template_id} SET status = ? WHERE intention_id = ?`).bind(status, intentionId).run();
	return;
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
 *
 * Também deve lidar com URLs do tipo:
 *  https://.../file/qrcodes/P-9GUI29F4Ey.svg
 *  ou /qrcodes/P-9GUI29F4Ey.svg
 */
function r2KeyFromPublicUrl(publicUrl: string): string | null {
	try {
		// se já vier apenas a key (ex: "qrcodes/xxx.png"), retorna direto
		if (!publicUrl.includes('://') && !publicUrl.startsWith('/')) {
			// heurística: se contiver barras e não for URL, assumimos que é chave
			return publicUrl;
		}

		const u = new URL(publicUrl);
		// procura por /file/ (se você expõe via /file/:key)
		const idxFile = u.pathname.indexOf('/file/');
		if (idxFile >= 0) {
			return u.pathname.slice(idxFile + '/file/'.length);
		}
		// se caminho contém '/file' sem slash final
		if (u.pathname.startsWith('/file')) {
			return u.pathname.replace(/^\/file\/?/, '');
		}
		// se caminho já começa com /qrcodes/ ou temp/
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

	const renewUrl = `https://${site}/my-dedications`;
	const expirationDate = new Date(expiresAt).toLocaleDateString('pt-BR');
	const subject = `❌ Sua dedicatória expirou - Renove agora`;

	// html omitido aqui por brevidade — mantenha o template que você já usa
	const html = `
<!DOCTYPE html>
<html lang="pt-BR">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sua dedicatória expirou</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap'); .email-container { max-width: 650px; margin: 0 auto; font-family: 'Poppins', Arial, sans-serif; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,0.08); } .header { background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%); padding: 40px 30px; text-align: center; color: white; } .header h1 { font-size: 32px; font-weight: 700; margin: 0 0 10px; } .header p { font-size: 18px; opacity: 0.9; margin: 0; } .content { padding: 40px 30px; color: #333333; line-height: 1.6; } .expired-info { background: #fff8f8; border-left: 4px solid #ff6b6b; padding: 20px; border-radius: 0 8px 8px 0; margin: 25px 0; } .cta-container { text-align: center; margin: 40px 0; } .cta-button { display: inline-block; padding: 18px 45px; background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%); color: white !important; text-decoration: none; font-weight: 600; font-size: 18px; border-radius: 50px; box-shadow: 0 6px 15px rgba(46, 204, 113, 0.3); transition: all 0.3s ease; } .cta-button:hover { transform: translateY(-3px); box-shadow: 0 10px 25px rgba(46, 204, 113, 0.4); } .benefits { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 40px 0; } .benefit-card { background: #f8f9ff; border-radius: 12px; padding: 25px; text-align: center; transition: transform 0.3s ease; } .benefit-card:hover { transform: translateY(-5px); } .benefit-icon { font-size: 36px; margin-bottom: 15px; color: #6a11cb; } .discount-badge { background: #ffeb3b; color: #333; padding: 8px 20px; border-radius: 50px; display: inline-block; font-weight: 600; margin: 15px 0; animation: pulse 2s infinite; } .contact { background: #f0f7ff; border-radius: 12px; padding: 25px; text-align: center; margin: 30px 0; } .footer { background: #f8f9fa; padding: 25px; text-align: center; color: #6c757d; font-size: 13px; } .logo { color: #2575fc; font-weight: 700; font-size: 22px; letter-spacing: 1px; margin-bottom: 15px; } @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.05); } 100% { transform: scale(1); } }
    </style>
</head>

<body style="margin: 0; padding: 20px; background: #f5f7ff;">
    <div class="email-container">
        <div class="header">
            <h1>📅 Sua dedicatória expirou!</h1>
            <p>Renove agora para manter sua mensagem especial disponível</p>
        </div>
        <div class="content">
            <p>Olá,</p>
            <div class="expired-info">
                <p>Sua dedicatória no modelo <strong>${templateLabels(
									templateLabels(templateId)
								)}</strong> expirou em <strong>${expirationDate}</strong>.</p>
            </div>
            <p style="font-size: 18px; text-align: center;">✨ <em>"As melhores mensagens merecem permanecer vivas"</em></p>
            <div class="cta-container">
                <p>Renove agora e mantenha sua dedicatória ativa por mais 1 ano!</p> <a href="${renewUrl}" class="cta-button"> RENOVAR MINHA DEDICATÓRIA </a> </div>
            <div class="discount-badge"> ⏰ OFERECEMOS 10% DE DESCONTO PARA RENOVAÇÕES NAS PRÓXIMAS 48 HORAS! </div>
            <h2 style="text-align: center; margin-top: 40px;">Por que renovar sua dedicatória?</h2>
            <div class="benefits">
                <div class="benefit-card">
                    <div class="benefit-icon">🔗</div>
                    <h3>Link Ativo</h3>
                    <p>Mantenha seu link permanente para compartilhar quando quiser</p>
                </div>
                <div class="benefit-card">
                    <div class="benefit-icon">💌</div>
                    <h3>Memórias Preservadas</h3>
                    <p>Guarde essa mensagem especial para sempre</p>
                </div>
                <div class="benefit-card">
                    <div class="benefit-icon">🎁</div>
                    <h3>Vantagens Exclusivas</h3>
                    <p>Acesso a recursos premium e novas funcionalidades</p>
                </div>
            </div>
            <div class="contact">
                <h3>Precisa de ajuda?</h3>
                <p>Estamos aqui para te ajudar com qualquer dúvida ou problema!</p>
                <p>Entre em contato: <strong>dedicart.help@gmail.com</strong></p>
            </div>
        </div>
        <div class="footer">
            <div class="logo">DEDICART</div>
            <p>Este é um e-mail automático. Por favor não responda diretamente.</p>
            <p>© ${new Date().getFullYear()} Dedicart - Todos os direitos reservados</p>
            <p><a href="https://dedicart.com.br/pt/privacidade" style="color: #6c757d; text-decoration: underline;">Política de Privacidade</a> | <a href="https://dedicart.com.br/pt/terms" style="color: #6c757d; text-decoration: underline;">Termos de Uso</a></p>
        </div>
    </div>
</body>

</html>`;
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
			try {
				return await res.json();
			} catch {
				return {};
			}
		}

		if (res.status === 429 || res.status >= 500) {
			const backoff = 500 * attempt;
			console.warn(`Brevo response ${res.status} — retrying after ${backoff}ms (attempt ${attempt})`);
			await new Promise((r) => setTimeout(r, backoff));
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
