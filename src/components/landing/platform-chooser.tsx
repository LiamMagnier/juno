"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { Globe, Laptop, Smartphone } from "@/components/ui/icons";
import { PublicAction } from "@/components/public/public-motion";

const PLATFORMS = [
  {id:"mac",label:"Mac",title:"Alevr for Mac",body:"Chat and Code in a native workspace. Bring your repository, review changes, and keep your work close.",icon:Laptop,href:"/download",action:"Download for Mac"},
  {id:"web",label:"Browser",title:"Open your workspace anywhere.",body:"Nothing to install. Sign in from any computer and pick up your conversations with their context intact.",icon:Globe,href:"/sign-up",action:"Create account"},
  {id:"iphone",label:"iPhone",title:"Your work, in your pocket.",body:"Voice, camera, and your projects. Alevr for iPhone is coming to the App Store.",icon:Smartphone,href:null,action:null},
];

export function PlatformChooser() {
  return <Tabs.Root defaultValue="mac" className="alevr-platform-chooser">
    <Tabs.List aria-label="Choose your platform" className="alevr-platform-tabs">{PLATFORMS.map(platform=><Tabs.Trigger key={platform.id} value={platform.id}><platform.icon aria-hidden className="size-5" />{platform.label}</Tabs.Trigger>)}</Tabs.List>
    {PLATFORMS.map(platform=><Tabs.Content forceMount key={platform.id} value={platform.id} className="alevr-platform-panel">
      <div className="alevr-platform-symbol" aria-hidden="true"><ContinuumMark size={104} /><platform.icon className="size-7" /></div>
      <div><h3 className="font-serif">{platform.title}</h3><p className="mt-5 max-w-lg text-body-lg leading-relaxed text-muted-foreground">{platform.body}</p><div className="mt-8">{platform.href ? <PublicAction href={platform.href}>{platform.action}</PublicAction> : <p className="text-ui text-muted-foreground">Coming to the App Store</p>}</div></div>
    </Tabs.Content>)}
  </Tabs.Root>;
}
