import WebSocket from "ws";
import { readFileSync } from "node:fs";
for (const f of ["../.env","../.env.local"]) { try { for (const line of readFileSync(f,"utf8").split("\n")) { const t=line.trim(); if(!t||t.startsWith("#"))continue; const eq=t.indexOf("="); if(eq<=0)continue; const k=t.slice(0,eq).trim(); let v=t.slice(eq+1).trim(); const q=v.match(/^(["'])([\s\S]*)\1$/); if(q)v=q[2]; if(!(k in process.env))process.env[k]=v; } } catch{} }
const ws = new WebSocket("wss://api.minimax.io/ws/v1/t2a_v2",{headers:{Authorization:`Bearer ${process.env.MINIMAX_API_KEY}`}});
let audio=0;
ws.on("open",()=>ws.send(JSON.stringify({event:"task_start",model:"speech-2.6-turbo",voice_setting:{voice_id:"English_expressive_narrator",speed:1,vol:1,pitch:0},audio_setting:{format:"pcm",sample_rate:24000,channel:1}})));
ws.on("message",(d)=>{
  const m=JSON.parse(d.toString());
  if(m.event==="connected_success"||m.event==="task_started"){ if(m.event==="task_started")ws.send(JSON.stringify({event:"task_continue",text:"Hello from the Juno voice relay."})); console.log("evt:",m.event); }
  else if(m.event==="task_continued"){ audio+=(m.data?.audio||"").length/2; if(m.is_final){console.log("TTS PCM bytes:",audio,`(~${(audio/2/24000).toFixed(2)}s)`);ws.close();process.exit(audio>4800?0:1);} }
  else console.log("evt:",m.event,JSON.stringify(m.base_resp||{}).slice(0,120));
});
ws.on("error",(e)=>{console.log("ERR",e.message);process.exit(1);});
setTimeout(()=>{console.log("TIMEOUT, bytes:",audio);process.exit(audio>4800?0:1);},20000);
