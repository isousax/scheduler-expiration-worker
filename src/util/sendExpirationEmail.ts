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
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sua dedicatória expirou - Renove agora</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap");

      /* Reset CSS para compatibilidade entre clients de e-mail */
      body,
      table,
      td,
      p,
      a {
        font-family: "Inter", Arial, sans-serif;
        -webkit-text-size-adjust: 100%;
        -ms-text-size-adjust: 100%;
      }
      body {
        margin: 0;
        padding: 0;
        width: 100% !important;
        background-color: #f7f9fc;
      }
      img {
        border: 0;
        outline: none;
        text-decoration: none;
        -ms-interpolation-mode: bicubic;
      }
      table {
        border-collapse: collapse;
        mso-table-lspace: 0pt;
        mso-table-rspace: 0pt;
      }

      /* Estilos principais */
      .container {
        max-width: 100%;
        width: 100%;
        margin: 0 auto;
        padding: 0 15px;
        box-sizing: border-box;
      }
      .email-wrapper {
        width: 100%;
        margin: 0 auto;
        background-color: #f7f9fc;
        padding: 20px 0;
      }
      .email-card {
        background: #ffffff;
        border-radius: 16px;
        overflow: hidden;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
        margin: 0 auto;
        max-width: 600px;
      }
      .header {
        background: linear-gradient(135deg, #8a51ee 0%, #625af6 100%);
        padding: 30px 25px;
        text-align: center;
        color: white;
      }
      .header h1 {
        font-size: 24px;
        font-weight: 700;
        margin: 0 0 10px;
        line-height: 1.3;
      }
      .header p {
        font-size: 16px;
        opacity: 0.9;
        margin: 0;
        line-height: 1.5;
      }
      .content {
        padding: 30px 25px;
        color: #334155;
        line-height: 1.6;
        font-size: 16px;
      }
      .expired-alert {
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 12px;
        padding: 20px;
        margin: 20px 0;
        display: flex;
        align-items: flex-start;
      }
      .alert-icon {
        margin-right: 15px;
        font-size: 24px;
        color: #dc2626;
      }
      .alert-content h3 {
        margin: 0 0 8px;
        font-size: 18px;
        color: #dc2626;
      }
      .alert-content p {
        margin: 0;
        font-size: 15px;
        color: #7c3aed;
      }
      .quote {
        text-align: center;
        font-style: italic;
        color: #64748b;
        padding: 15px 0;
        margin: 25px 0;
        border-top: 1px solid #e2e8f0;
        border-bottom: 1px solid #e2e8f0;
      }
      .cta-section {
        text-align: center;
        margin: 30px 0;
      }
      .cta-button {
        display: inline-block;
        padding: 16px 40px;
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: white !important;
        text-decoration: none;
        font-weight: 600;
        font-size: 16px;
        border-radius: 12px;
        box-shadow: 0 4px 6px rgba(5, 150, 105, 0.2);
        transition: all 0.3s ease;
      }
      .cta-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 12px rgba(5, 150, 105, 0.25);
      }
      .discount-badge {
        background: #fffbeb;
        border: 1px dashed #f59e0b;
        border-radius: 12px;
        padding: 16px;
        text-align: center;
        margin: 25px 0;
        color: #d97706;
        font-weight: 600;
      }
      .benefits {
        margin: 30px 0;
      }
      .benefit-item {
        display: flex;
        align-items: center;
        margin-bottom: 20px;
      }
      .benefit-icon {
        width: 48px;
        height: 48px;
        background: #f1f5f9;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-right: 15px;
        flex-shrink: 0;
        font-size: 20px;
        color: #7c3aed;
      }
      .benefit-text h3 {
        margin: 0 0 5px;
        font-size: 16px;
        color: #1e293b;
      }
      .benefit-text p {
        margin: 0;
        font-size: 14px;
        color: #64748b;
      }
      .contact {
        background: #f8fafc;
        border-radius: 12px;
        padding: 20px;
        text-align: center;
        margin: 30px 0 0;
      }
      .contact h3 {
        margin: 0 0 10px;
        font-size: 16px;
        color: #1e293b;
      }
      .contact p {
        margin: 5px 0;
        font-size: 14px;
        color: #64748b;
      }
      .footer {
        background: #f1f5f9;
        padding: 25px;
        text-align: center;
        color: #64748b;
        font-size: 13px;
        border-top: 1px solid #e2e8f0;
      }
      .logo {
        color: #4f46e5;
        font-weight: 700;
        font-size: 18px;
        letter-spacing: 0.5px;
        margin-bottom: 10px;
      }
      .footer-links {
        margin: 15px 0;
      }
      .footer-links a {
        color: #64748b;
        text-decoration: underline;
        margin: 0 10px;
      }

      /* Media queries para responsividade */
      @media only screen and (max-width: 480px) {
        .header {
          padding: 25px 20px;
        }
        .header h1 {
          font-size: 22px;
        }
        .content {
          padding: 25px 20px;
        }
        .cta-button {
          padding: 14px 30px;
          width: 100%;
          box-sizing: border-box;
        }
        .benefit-item {
          flex-direction: column;
          text-align: center;
        }
        .benefit-icon {
          margin-right: 0;
          margin-bottom: 10px;
        }
      }
    </style>
  </head>

  <body>
    <sectino class="email-wrapper justify-center">
      <div class="container">
        <div class="email-card">
          <div class="header">
            <h1>⏰ Sua dedicatória expirou</h1>
            <p>Renove agora e mantenha sua mensagem especial disponível</p>
          </div>

          <div class="content">
            <p>Olá,</p>

            <div class="expired-alert">
              <div class="alert-icon">❌</div>
              <div class="alert-content">
                <h3>Dedicatória Expirada</h3>
                <p>
                  Sua dedicatória no modelo
                  <strong>${templateLabels(templateId)}</strong> expirou em
                  <strong>${expirationDate}</strong>.
                </p>
              </div>
            </div>

            <div class="quote">
              <p>"As melhores mensagens merecem permanecer vivas"</p>
            </div>

            <div class="cta-section">
              <p>
                Renove agora e mantenha sua dedicatória ativa por mais 1 ano!
              </p>
              <a href="${renewUrl}" class="cta-button">RENOVAR AGORA</a>
            </div>

            <div class="discount-badge">
              ⚡ OFERECEMOS 20% DE DESCONTO PARA RENOVAÇÕES NAS PRÓXIMAS 48
              HORAS!
            </div>

            <h2 style="text-align: center; margin: 30px 0 20px; color: #1e293b">
              Por que renovar sua dedicatória?
            </h2>

            <div class="benefits">
              <div class="benefit-item">
                <div class="benefit-icon">🔗</div>
                <div class="benefit-text">
                  <h3>Link Ativo Permanentemente</h3>
                  <p>
                    Mantenha seu link permanente para compartilhar quando quiser
                  </p>
                </div>
              </div>

              <div class="benefit-item">
                <div class="benefit-icon">💌</div>
                <div class="benefit-text">
                  <h3>Memórias Preservadas</h3>
                  <p>Guarde essa mensagem especial para sempre</p>
                </div>
              </div>

              <div class="benefit-item">
                <div class="benefit-icon">🎁</div>
                <div class="benefit-text">
                  <h3>Vantagens Exclusivas</h3>
                  <p>Acesso a recursos premium e novas atualizações</p>
                </div>
              </div>
            </div>

            <div class="contact">
              <h3>Precisa de ajuda?</h3>
              <p>
                Estamos aqui para te ajudar com qualquer dúvida ou problema!
              </p>
              <p><strong>dedicart.help@gmail.com</strong></p>
            </div>
          </div>

          <div class="footer">
            <div class="logo">DEDICART</div>
            <p>
              Este é um e-mail automático. Por favor não responda diretamente.
            </p>
            <div class="footer-links">
              <a href="https://dedicart.com.br/pt/privacidade"
                >Política de Privacidade</a
              >
              <a href="https://dedicart.com.br/pt/terms">Termos de Uso</a>
            </div>
            <p>
              © ${new Date().getFullYear()} Dedicart - Todos os direitos
              reservados
            </p>
          </div>
        </div>
      </div>
    </sectino>
  </body>
</html>
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
