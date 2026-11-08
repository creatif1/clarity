// Single-file Cloudflare Worker: serves the site and runs the payment routes.
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const CONSENT_VERSION = "v1.0";
const sb = (env, path, init = {}) => fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
  ...init,
  headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, ...(String(env.SUPABASE_SERVICE_ROLE_KEY).startsWith("sb_") ? {} : { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }), "content-type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
});

// 1) Start a Stripe Checkout payment (needs email, consent, and the human check)
async function checkout(request, env) {
  let b; try { b = await request.json(); } catch { return J({ error: "Bad request." }, 400); }
  const email = String(b.email || "").trim().toLowerCase();
  if (email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J({ error: "Enter a valid email address." }, 400);
  if (b.consent !== true) return J({ error: "Please agree to the Terms to continue." }, 400);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (env.HUMAN_CHECK === "on") {
  const t = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: new URLSearchParams({ secret: env.TURNSTILE_SECRET || "", response: String(b.turnstile || ""), remoteip: ip }),
    }).then(r => r.json()).catch(() => ({}));
    if (!t.success) return J({ error: "Human check failed. Please try again. (Code: " + ((t["error-codes"] && t["error-codes"].join(", ")) || "no reply from Cloudflare") + ")" }, 400);
  }

  const token = hex(crypto.getRandomValues(new Uint8Array(24)));
  const origin = new URL(request.url).origin;
  const s = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      mode: "payment", customer_email: email,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": env.PRICE_CENTS || "3000",
      "line_items[0][price_data][product_data][name]": "8-Card Tarot Reading",
      success_url: `${origin}/?paid=${token}`, cancel_url: `${origin}/#pay`,
    }),
  }).then(r => r.json());
  if (!s.url) return J({ error: "Payment could not start. Please try again." }, 502);

  const r = await sb(env, "orders", { method: "POST", body: JSON.stringify({
    email, token, stripe_session_id: s.id, status: "pending",
    consent_version: CONSENT_VERSION, consented_at: new Date().toISOString(), consent_ip: ip,
  }) });
  if (!r.ok) return J({ error: "Could not save your order. You were not charged." }, 500);
  return J({ url: s.url });
}

// 2) Stripe tells us a payment succeeded (signature checked, so it can't be faked)
async function webhook(request, env) {
  const raw = await request.text();
  const parts = (request.headers.get("stripe-signature") || "").split(",").map(x => x.split("="));
  const ts = parts.find(x => x[0] === "t")?.[1];
  const sigs = parts.filter(x => x[0] === "v1").map(x => x[1]);
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return J({ error: "Stale or missing signature." }, 400);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${raw}`)));
  if (!sigs.includes(mac)) return J({ error: "Bad signature." }, 400);

  const ev = JSON.parse(raw);
  const o = ev.data && ev.data.object;
  if (ev.type === "checkout.session.completed" && o.payment_status === "paid") {
    const r = await sb(env, `orders?stripe_session_id=eq.${encodeURIComponent(o.id)}`, { method: "PATCH", body: JSON.stringify({ status: "paid" }) });
    if (!r.ok) return J({ error: "Database error." }, 500); // makes Stripe retry
  }
  return J({ ok: true });
}

// 3) Deliver the reading only to a paid order; the 8 cards are drawn once, on the server, and saved
async function reading(request, env) {
  const token = new URL(request.url).searchParams.get("t") || "";
  if (!/^[a-f0-9]{48}$/.test(token)) return J({ error: "This reading link is not valid." }, 400);
  const o = (await (await sb(env, `orders?token=eq.${token}&select=id,status,cards`)).json())[0];
  if (!o) return J({ error: "Reading not found." }, 404);
  if (o.status !== "paid") return J({ pending: true });
  let cards = o.cards;
  if (!cards) {
    const pool = [...Array(22).keys()]; cards = [];
    for (let i = 0; i < 8; i++) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % pool.length;
      cards.push({ i: pool.splice(j, 1)[0], rev: crypto.getRandomValues(new Uint8Array(1))[0] % 4 === 0 });
    }
    await sb(env, `orders?id=eq.${o.id}`, { method: "PATCH", body: JSON.stringify({ cards }) });
  }
  return J({ cards, calendly: env.CALENDLY_LINK || null });
}


// ---- Pages are built into this file so it works as a plain Worker (no Pages project needed) ----
const PAGES = { index: "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Readings by Ruben | Higher Thought</title>\n<meta name=\"description\" content=\"Tarot readings for reflection and inspiration. Try a free 3-card reading or get the full 8-card reading.\">\n<script src=\"https://challenges.cloudflare.com/turnstile/v0/api.js\" async defer></script>\n<style>\n:root{--bg:#B19CD9;--ink:#2a1442;--acc:#4b2b7f}\n*{box-sizing:border-box}\nbody{margin:0;font:17px/1.65 Georgia,\"Times New Roman\",serif;color:var(--ink);background:var(--bg)}\nmain{max-width:900px;margin:auto;padding:20px 18px 60px}\nheader{text-align:center;padding:40px 0 8px}\n.brand{color:var(--acc);letter-spacing:.3em;font-size:.85rem}\nh1{font-weight:400;font-size:clamp(2.4rem,8vw,4.2rem);line-height:1.1;color:var(--ink);margin:.25em 0}\nh2{font-weight:400;color:var(--ink);margin:0 0 .3em}\n.tag{color:var(--acc);letter-spacing:.22em;font-size:.85rem}\nsection{border:1px solid var(--acc);border-radius:14px;padding:24px;margin:28px 0;background:rgba(255,255,255,.55)}\nbutton,.btn{background:var(--ink);color:#fff;border:0;border-radius:8px;padding:13px 24px;font:700 1rem Georgia,serif;cursor:pointer;text-decoration:none;display:inline-block}\nbutton:disabled{opacity:.45;cursor:not-allowed}\n:focus-visible{outline:3px solid var(--ink);outline-offset:2px}\ninput[type=email]{width:100%;max-width:400px;padding:12px;border-radius:8px;border:1px solid var(--acc);background:#fff;color:var(--ink);font:inherit}\nlabel{display:block;margin:14px 0;font-size:.92rem;max-width:560px}\na{color:var(--acc)}\n.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-top:18px}\n.card{border:1px solid var(--acc);border-radius:10px;padding:14px;background:rgba(255,255,255,.75)}\n.card small{color:var(--acc)}.card h3{margin:.2em 0;color:var(--ink);font-weight:400;font-size:1.25rem}.card p{margin:0;font-size:.95rem}\n.rev{color:#6b2fa0;font-size:.82rem}\n#msg{color:#8a1c1c;min-height:1.5em}\nfooter{text-align:center;font-size:.82rem;border-top:1px solid var(--acc);padding-top:18px}\n</style></head><body><main>\n<header><div class=\"brand\">HIGHER THOUGHT</div><h1>Readings by Ruben</h1><div class=\"tag\">TAROT \u00b7 INSIGHT \u00b7 REFLECTION</div></header>\n\n<div id=\"home\">\n<section id=\"free\"><h2>Free 3-card reading</h2>\n<p>Draw three cards for your past, present, and future, and see what they bring up for you.</p>\n<button id=\"drawFree\">Draw my cards</button><div class=\"cards\" id=\"freeOut\"></div></section>\n\n<section id=\"pay\"><h2>Full 8-card reading: $30</h2>\n<p>A deeper spread covering your situation, challenge, foundation, past, strength, near future, advice, and outcome. You get it right after you pay, with the option to book a live session.</p>\n<input id=\"email\" type=\"email\" placeholder=\"Your email address\" autocomplete=\"email\" aria-label=\"Your email address\">\n<label><input type=\"checkbox\" id=\"agree\"> I am 18 or older. I agree to the <a href=\"legal.html#terms\" target=\"_blank\">Terms</a>, <a href=\"legal.html#privacy\" target=\"_blank\">Privacy Policy</a>, and <a href=\"legal.html#disclaimer\" target=\"_blank\">Disclaimer</a>. I understand readings are for entertainment and reflection, not professional advice.</label>\n<div class=\"cf-turnstile\" data-sitekey=\"YOUR_TURNSTILE_SITE_KEY\"></div>\n<p><button id=\"buy\" disabled>Pay $30 and get my reading</button></p><div id=\"msg\" role=\"alert\"></div></section>\n</div>\n\n<div id=\"paid\" hidden><section><h2>Your 8-card reading</h2><p id=\"pstat\">Confirming your payment\u2026</p>\n<div class=\"cards\" id=\"paidOut\"></div><p id=\"cal\"></p>\n<p><small>This page's link is your private copy of the reading. Bookmark it to come back.</small></p></section></div>\n\n<footer><p>Readings are for entertainment and personal reflection only, not medical, mental health, legal, or financial advice. In a crisis, call or text 988 (U.S.) or 911.</p>\n<p><a href=\"legal.html#terms\">Terms</a> \u00b7 <a href=\"legal.html#privacy\">Privacy</a> \u00b7 <a href=\"legal.html#disclaimer\">Disclaimer</a> \u00b7 <a href=\"legal.html#refunds\">Refunds</a></p></footer>\n</main>\n<script>\nconst D=\"The Fool|new beginnings, a leap of faith|hesitation, recklessness;The Magician|skill, focus, making it happen|scattered energy, untapped talent;The High Priestess|intuition, inner knowing|ignoring your gut, hidden motives;The Empress|nurturing, abundance, creativity|burnout, creative block;The Emperor|structure, authority, stability|rigidity, control issues;The Hierophant|tradition, guidance, learning|questioning the rules, breaking with convention;The Lovers|alignment, love, meaningful choices|misalignment, indecision;The Chariot|drive, determination, victory|no direction, forcing things;Strength|courage, patience, gentle power|self-doubt, drained confidence;The Hermit|reflection, solitude, wisdom|isolation, avoiding inner work;Wheel of Fortune|cycles, change, luck turning|resisting change, setbacks;Justice|fairness, truth, accountability|imbalance, dodging responsibility;The Hanged Man|pause, new perspective, surrender|stalling, needless sacrifice;Death|endings, transformation, release|clinging to the past;Temperance|balance, patience, moderation|excess, being out of sync;The Devil|attachment, temptation, patterns that bind|breaking free, taking back power;The Tower|sudden change, truth revealed|avoiding the inevitable, slow rebuilding;The Star|hope, healing, renewal|discouragement, lost faith;The Moon|uncertainty, dreams, hidden feelings|fog lifting, fears fading;The Sun|joy, success, vitality|passing clouds, dimmed optimism;Judgement|awakening, reckoning, a calling|self-doubt, ignoring the call;The World|completion, wholeness, achievement|unfinished business, nearly there\".split(\";\").map(s=>s.split(\"|\"));\nconst POS3=[\"Past\",\"Present\",\"Future\"],POS8=[\"Situation\",\"Challenge\",\"Foundation\",\"Past\",\"Strength\",\"Near future\",\"Advice\",\"Outcome\"];\nconst $=id=>document.getElementById(id),rnd=n=>crypto.getRandomValues(new Uint32Array(1))[0]%n;\nfunction show(el,list,labels){el.innerHTML=list.map((c,k)=>{const d=D[c.i];return `<div class=\"card\"><small>${labels[k]}</small><h3>${d[0]}</h3>${c.rev?'<div class=\"rev\">Reversed</div>':''}<p>${c.rev?d[2]:d[1]}</p></div>`}).join(\"\")}\n\n$(\"drawFree\").onclick=()=>{const p=[...D.keys()],c=[];for(let k=0;k<3;k++)c.push({i:p.splice(rnd(p.length),1)[0],rev:rnd(4)==0});show($(\"freeOut\"),c,POS3)};\n$(\"agree\").onchange=()=>{$(\"buy\").disabled=!$(\"agree\").checked};\n$(\"buy\").onclick=async()=>{\n  $(\"msg\").textContent=\"\";$(\"buy\").disabled=true;\n  try{\n    const r=await fetch(\"/api/checkout\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify({email:$(\"email\").value,consent:$(\"agree\").checked,turnstile:(document.querySelector('[name=\"cf-turnstile-response\"]')||{}).value||\"\"})});\n    const j=await r.json(); if(j.url){location.href=j.url}else throw new Error(j.error);\n  }catch(e){$(\"msg\").textContent=e.message||\"Something went wrong. Please try again.\";$(\"buy\").disabled=!$(\"agree\").checked;if(window.turnstile)turnstile.reset()}\n};\n\nconst tok=new URLSearchParams(location.search).get(\"paid\");\nif(tok){$(\"home\").hidden=true;$(\"paid\").hidden=false;let n=0;\n  (async function poll(){\n    try{const j=await (await fetch(\"/api/reading?t=\"+encodeURIComponent(tok))).json();\n      if(j.cards){$(\"pstat\").textContent=\"Thank you. Here is your reading.\";show($(\"paidOut\"),j.cards,POS8);\n        if(j.calendly){const a=document.createElement(\"a\");a.className=\"btn\";a.href=j.calendly;a.target=\"_blank\";a.rel=\"noopener\";a.textContent=\"Book a live session\";$(\"cal\").appendChild(a)}return}\n      if(j.error){$(\"pstat\").textContent=j.error;return}\n    }catch(e){}\n    if(++n<20)setTimeout(poll,2000);else $(\"pstat\").textContent=\"Still confirming your payment. Please refresh in a minute, or contact us at [CONTACT EMAIL].\";\n  })()}\n</script></body></html>\n", legal: "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Terms, Privacy, Disclaimer | Readings by Ruben</title>\n<style>body{margin:0;background:#B19CD9;color:#2a1442;font:17px/1.65 Georgia,serif}main{max-width:760px;margin:auto;padding:24px 18px 60px}h1,h2{font-weight:400;color:#2a1442}h2{border-top:1px solid #4b2b7f;padding-top:24px;margin-top:36px}a{color:#4b2b7f}.draft{background:#fff6d9;border:1px solid #7a5a12;padding:12px;border-radius:8px;font-size:.9rem}</style></head><body><main>\n<p><a href=\"/\">&larr; Back to Readings by Ruben</a></p>\n<p class=\"draft\"><b>Draft:</b> fill in every [BRACKET] and have an attorney review these pages before launch. Effective date: [EFFECTIVE DATE]. Operated by [BUSINESS NAME], doing business as Readings by Ruben, [MAILING ADDRESS], [CONTACT EMAIL].</p>\n\n<h2 id=\"terms\">Terms of Service</h2>\n<p><b>1. Entertainment only.</b> Readings are for entertainment and personal reflection. Tarot is symbolic; we do not predict the future or guarantee any outcome.</p>\n<p><b>2. Adults only.</b> You must be 18 or older.</p>\n<p><b>3. Services and prices.</b> We offer a free 3-card reading and a paid 8-card reading ($30). Prices are in U.S. dollars. We may change or stop any service, and price changes apply to future purchases.</p>\n<p><b>4. Payments.</b> Payments are processed by Stripe. We never see or store your full card number. You confirm you are authorized to use the payment method.</p>\n<p><b>5. Your reading link.</b> After payment you receive a private link to your reading. Keep it private; do not share, sell, or republish paid readings.</p>\n<p><b>6. Acceptable use.</b> No bots, scripts, card testing, attempts to bypass the paywall or security, harassment, or unlawful use. We may block or refuse service to anyone abusing the site.</p>\n<p><b>7. Not professional advice.</b> Readings are not medical, mental health, legal, or financial advice. If you are in crisis, call or text 988 (U.S.) or 911.</p>\n<p><b>8. Ownership.</b> The site and its content belong to us. You may use your reading personally, not commercially.</p>\n<p><b>9. No warranties; limited liability.</b> The services are provided \"as is.\" To the fullest extent the law allows, our total liability for any claim is limited to the amount you paid for the reading at issue, and we are not liable for indirect or consequential damages.</p>\n<p><b>10. Governing law.</b> Georgia law governs these Terms. Before filing a claim, contact us and allow [30] days to resolve it. Disputes go to the courts in [COUNTY], Georgia.</p>\n<p><b>11. Changes.</b> We may update these Terms by posting a new effective date.</p>\n\n<h2 id=\"privacy\">Privacy Policy</h2>\n<p><b>What we collect:</b> your email; the time you agreed to our Terms and which version; your IP address (for security and abuse prevention); and your reading. Stripe collects your payment details; we receive only payment confirmation.</p>\n<p><b>How we use it:</b> to deliver your reading, process payment, prevent fraud and abuse, answer your messages, and meet legal and tax duties. We do not sell your personal information or use it for advertising.</p>\n<p><b>Who we share it with:</b> only services that help us run the business: Stripe (payments), Supabase (database), Cloudflare (hosting and security), and Calendly (scheduling, if you book).</p>\n<p><b>How long we keep it:</b> readings and emails for [1 year]; payment and tax records for [7 years]; security logs for [30 days].</p>\n<p><b>Your rights:</b> you may ask to see, correct, or delete your information by emailing [CONTACT EMAIL]. We respond within [30] days, except for records we must legally keep.</p>\n<p><b>Security and children:</b> we limit access to your data, but no system is perfectly secure. The site is not for anyone under 18.</p>\n\n<h2 id=\"disclaimer\">Disclaimer</h2>\n<p>Readings are provided as entertainment and personal inspiration. They do not diagnose, treat, or cure any condition and are not a substitute for a doctor, therapist, attorney, financial advisor, or other licensed professional. Do not make major decisions about health, safety, money, legal matters, or relationships based only on a reading. If you are in crisis, call or text 988 (U.S.) or 911. You use the site and any reading at your own discretion and risk.</p>\n\n<h2 id=\"refunds\">Refunds</h2>\n<p>[CHOOSE ONE:] Because readings are delivered instantly and cannot be returned, all sales are final once delivered. If a technical problem prevents delivery, or you were charged in error, contact us within [7] days and we will fix it or refund you. Please contact us before filing a chargeback.</p>\n</main></body></html>\n" };
const stripCheck = (h, env) => env.HUMAN_CHECK === "on" ? h : h
  .replace(/<div class="cf-turnstile"[^>]*><\/div>/, "")
  .replace(/<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js"[^>]*><\/script>/, "");
const fill = (h0, env) => stripCheck(h0, env)
  .replaceAll("YOUR_TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY || "")
  .replaceAll("[CONTACT EMAIL]", env.CONTACT_EMAIL || "[CONTACT EMAIL]")
  .replaceAll("[BUSINESS NAME]", env.BUSINESS_NAME || "[BUSINESS NAME]")
  .replaceAll("[MAILING ADDRESS]", env.MAILING_ADDRESS || "[MAILING ADDRESS]")
  .replaceAll("[EFFECTIVE DATE]", env.EFFECTIVE_DATE || "[EFFECTIVE DATE]");
const page = (h, env) => new Response(fill(h, env), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/checkout" && request.method === "POST") return await checkout(request, env);
      if (pathname === "/api/webhook" && request.method === "POST") return await webhook(request, env);
      if (pathname === "/api/reading" && request.method === "GET") return await reading(request, env);
    } catch (e) { return J({ error: "Server error. Please try again." }, 500); }
    if (pathname === "/" || pathname === "/index.html") return page(PAGES.index, env);
    if (pathname === "/legal.html" || pathname === "/legal") return page(PAGES.legal, env);
    return new Response("Not found", { status: 404 });
  },
};
