// node shoot.js <url> <out.png> <w> <h> <dpr> [fullPage] [reducedMotion]
const { chromium } = require('playwright');
(async()=>{const [url,out,w,h,dpr,full,rm]=process.argv.slice(2);const b=await chromium.launch();try{
const ctx=await b.newContext({viewport:{width:+w,height:+h},deviceScaleFactor:+dpr,reducedMotion:rm==='1'?'reduce':'no-preference'});
const p=await ctx.newPage();await p.goto(url);await p.evaluate(async()=>{await document.fonts.ready;for(const f of document.fonts){try{await f.load()}catch(e){}}});
await p.waitForTimeout(400);await p.screenshot({path:out,fullPage:full==='1'});}finally{await b.close();}})();
