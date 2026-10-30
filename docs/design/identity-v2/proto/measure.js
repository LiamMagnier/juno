const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();try{const p=await b.newPage();await p.goto(process.argv[2]);await p.evaluate(async()=>{await document.fonts.load('400 16px I');await document.fonts.ready;}); console.log('font loaded', await p.evaluate(()=>document.fonts.check('16px I')), await p.evaluate(()=>[...document.fonts].map(f=>f.family+':'+f.status).join(',')));
for(const ls of ['-0.008em','0em']){await p.evaluate(ls=>document.body.style.letterSpacing=ls,ls);
const out=[];for(const w of [568,576,584]){out.push(await p.evaluate(w=>measure(w),w));}console.log('letter-spacing',ls);for(const o of out)console.log(JSON.stringify(o));}
}finally{await b.close();}})();
