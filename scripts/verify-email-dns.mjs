import { resolveMx, resolveTxt } from "node:dns/promises";

const domain = process.env.JUNO_EMAIL_DOMAIN || "chat.liams.dev";
const organizationalDomain = process.env.JUNO_ORGANIZATIONAL_DOMAIN || "liams.dev";
const strict = process.argv.includes("--strict");
const resendKey = process.env.RESEND_API_KEY;

if (!resendKey) {
  console.error("RESEND_API_KEY is required to compare live DNS with Resend's exact domain records.");
  process.exit(2);
}

async function txt(name) {
  try { return (await resolveTxt(name)).map((parts) => parts.join("")); } catch { return []; }
}
async function mx(name) {
  try { return await resolveMx(name); } catch { return []; }
}

const headers = { Authorization: `Bearer ${resendKey}` };
const listResponse = await fetch("https://api.resend.com/domains", { headers });
if (!listResponse.ok) throw new Error(`Resend domain list failed with HTTP ${listResponse.status}`);
const listPayload = await listResponse.json();
const configured = (listPayload.data || []).find((item) => item.name === domain);
if (!configured) throw new Error(`Resend has no configured domain named ${domain}`);
const domainResponse = await fetch(`https://api.resend.com/domains/${configured.id}`, { headers });
if (!domainResponse.ok) throw new Error(`Resend domain detail failed with HTTP ${domainResponse.status}`);
const detail = await domainResponse.json();

const results = [];
for (const record of detail.records || []) {
  const rawName = String(record.name || "").replace(/\.$/, "");
  const recordName = rawName === organizationalDomain || rawName.endsWith(`.${organizationalDomain}`)
    ? rawName
    : `${rawName}.${organizationalDomain}`;
  if (record.type === "TXT") {
    const values = await txt(recordName);
    results.push({ kind: record.record || "TXT", name: recordName, ok: values.includes(record.value), status: record.status });
  } else if (record.type === "MX") {
    const values = await mx(recordName);
    const expectedHost = String(record.value || "").replace(/\.$/, "").toLowerCase();
    const expectedPriority = Number(record.priority);
    results.push({
      kind: record.record || "MX",
      name: recordName,
      ok: values.some((item) => item.exchange.replace(/\.$/, "").toLowerCase() === expectedHost && item.priority === expectedPriority),
      status: record.status,
    });
  }
}

const dmarcNames = [`_dmarc.${organizationalDomain}`, `_dmarc.${domain}`];
const dmarc = [];
for (const name of dmarcNames) {
  const policies = (await txt(name)).filter((value) => /^v=DMARC1\b/i.test(value));
  dmarc.push({ name, policies });
}
const organizationalPolicy = dmarc[0].policies[0] || "";
const enforced = /\bp=(?:quarantine|reject)\b/i.test(organizationalPolicy);

console.log(JSON.stringify({
  domain,
  resendDomainId: configured.id,
  resendStatus: detail.status,
  sendingEnabled: detail.capabilities?.sending === "enabled",
  records: results,
  dmarc,
  dmarcEnforced: enforced,
}, null, 2));

const recordsPass = results.length > 0 && results.every((result) => result.ok && result.status === "verified");
if (!recordsPass || (strict && !enforced)) process.exit(1);
