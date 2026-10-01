"use client";
import * as React from "react";
import { ContextComposerField } from "@/components/chat/context-composer-field";
import { composerFieldClass, ComposerShell } from "@/components/ui/composer-shell";
import type { ContextToken } from "@/lib/chat/context-tokens";
import { MENTION_KIND_ORDER, type MentionSearchResult } from "@/lib/mentions/types";
import { Button } from "@/components/ui/button";

const FIXTURES: MentionSearchResult["items"] = [
  {kind:"app",id:"github",label:"GitHub",icon:"app:github",connected:true,score:1,approval:{reads:"allow",changes:"ask",sends:"ask",deletes:"ask",summary:"Posting to GitHub will ask you first."}},
  {kind:"project",id:"cm000000000000000000000001",label:"Launch plan",icon:"project",score:1},
  {kind:"file",id:"cm000000000000000000000002",label:"Q3 Forecast.xlsx",icon:"file:sheet",score:1},
];
const loadMentions = async (query:string): Promise<MentionSearchResult> => ({query,kinds:[...MENTION_KIND_ORDER],items:FIXTURES.filter(i=>i.label.toLowerCase().includes(query.toLowerCase()))});
export function ContextEditorGallery() {
  const [text,setText] = React.useState(""); const [tokens,setTokens] = React.useState<ContextToken[]>([]);
  const [sent,setSent] = React.useState<{text:string;context:ContextToken[]}|null>(null);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  function send() {setSent({text,context:tokens});setText("");}
  return <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-6 p-6">
    <h1 className="font-serif text-display">What shall we work on?</h1>
    <p className="text-ui text-muted-foreground">Editor test gallery. These context items are synthetic fixtures. Type @, choose an item, then send.</p>
    <ComposerShell field={<ContextComposerField ref={ref} value={text} conversationId={null} onTokensChange={setTokens} loadMentions={loadMentions} aria-label="Test message" placeholder="Ask Juno" className={composerFieldClass} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}/>} action={<Button disabled={!text.trim()} onClick={send}>Send</Button>}/>
    <Button variant="ghost" onClick={()=>{setText("Restored plain draft");ref.current?.focus();}}>Restore draft</Button>
    <pre aria-label="Draft context" className="overflow-auto text-caption">{JSON.stringify({text,context:tokens},null,2)}</pre>
    {sent && <pre aria-label="Sent request" className="overflow-auto text-caption">{JSON.stringify(sent,null,2)}</pre>}
  </main>;
}
