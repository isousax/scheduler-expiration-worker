import { templateLabels } from './templateLabels';

export interface Env {
	DB: D1Database;
	R2: R2Bucket;
	BREVO_API_KEY?: string;
	EMAIL_FROM?: string; // ex: "Dedicart <no-reply@dedicart.com.br>"
	EMAIL_REPLY_TO?: string; // opcional
	SITE_DNS?: string; // ex: "dedicart.com.br"
}

/* ---------- envio de email via Brevo (Sendinblue) ---------- */
export default async function sendExpirationEmail(opts: {
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

/* ---------- parse sender ---------- */
function parseSender(from: string) {
	const m = from.match(/^(.*)<(.+@.+)>$/);
	if (m) return { name: m[1].trim().replace(/(^"|"$)/g, ''), email: m[2].trim() };
	return { name: 'Dedicart', email: from.trim() };
}
