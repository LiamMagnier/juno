"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const DOCUMENTS = [
  { href:"/legal/confidentialite", label:"Privacy" },
  { href:"/legal/cgu", label:"Terms" },
  { href:"/legal/cgv", label:"Terms of sale" },
  { href:"/legal/mentions-legales", label:"Legal notice" },
];

export function PublicDocumentNav() {
  const pathname = usePathname();
  return <nav aria-label="Legal documents" className="alevr-document-nav"><p className="text-ui font-medium">Legal</p>{DOCUMENTS.map(({href,label}) => <Link key={href} href={href} lang="fr" aria-current={pathname === href ? "page" : undefined}>{label}</Link>)}</nav>;
}
