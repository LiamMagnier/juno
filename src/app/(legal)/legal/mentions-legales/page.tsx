import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { DATABASE_HOST, DSA_CONTACT, HOST, MEDIATOR, SELLER, SERVICE_HOST } from "@/lib/legal/seller";
import { Fill } from "@/components/legal/fill";

/**
 * Mentions légales (LCEN art. 1-1 and 6) — the publisher's legal notice.
 *
 * Every owner-only fact comes from src/lib/legal/seller.ts and renders as a
 * visible "[À COMPLÉTER : …]" marker until it is filled in there. The host is
 * known from the deploy runbooks (Azure VM, Sweden Central) and is filled.
 */

// Legal pages have no per-user content; force-static keeps them SSG even
// though the root layout reads the session cookie (empty at build time).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Mentions légales",
  description: `Mentions légales de ${PRODUCT_NAME} (${SERVICE_HOST}) : éditeur, directeur de la publication, hébergeur, médiation, point de contact pour les signalements et propriété intellectuelle, conformément à la loi pour la confiance dans l'économie numérique (LCEN).`,
};

export default function MentionsLegalesPage() {
  return (
    <>
      <p className="font-mono text-label text-muted-foreground">{`${PRODUCT_NAME} · Informations légales`}</p>
      <h1 className="mt-3">Mentions légales</h1>
      <p className="text-muted-foreground">Dernière mise à jour : 4 octobre 2026.</p>

      <p>
        {`Conformément aux articles 1-1 et 6 de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans l'économie numérique (LCEN), les présentes mentions légales sont portées à la connaissance des utilisateurs du service ${PRODUCT_NAME}, accessible à l'adresse`}{" "}
        <strong>{SERVICE_HOST}</strong>.
      </p>

      <h2>1. Éditeur du service</h2>
      <ul>
        <li>
          Dénomination : <Fill value={SELLER.name} what="raison sociale, ou nom et prénom de l'entrepreneur individuel" />
        </li>
        <li>
          Forme juridique : <Fill value={SELLER.legalForm} what="forme juridique (SASU, EURL, entrepreneur individuel…)" />
        </li>
        <li>
          Capital social : <Fill value={SELLER.shareCapital} what="montant du capital social (sans objet pour un entrepreneur individuel)" />
        </li>
        <li>
          SIREN : <Fill value={SELLER.siren} what="numéro SIREN" /> —{" "}
          <Fill value={SELLER.registry} what="RCS de la ville du greffe, ou RNE" />
        </li>
        <li>
          Siège : <Fill value={SELLER.address} what="adresse postale complète" />
        </li>
        <li>
          Numéro de TVA intracommunautaire : <Fill value={SELLER.vatNumber} what="numéro de TVA FR…" />
        </li>
        <li>
          Adresse électronique : <Fill value={SELLER.email} what="adresse e-mail de contact" />
        </li>
        <li>
          Téléphone : <Fill value={SELLER.phone} what="numéro de téléphone" />
        </li>
      </ul>

      <h2>2. Directeur de la publication</h2>
      <p>
        Le directeur de la publication est{" "}
        <Fill value={SELLER.publicationDirector} what="nom et prénom du directeur de la publication (le représentant légal)" />.
      </p>

      <h2>3. Hébergement</h2>
      <p>L&apos;application est hébergée par :</p>
      <ul>
        <li>
          <strong>{HOST.name}</strong>, <Fill value={HOST.address} what="adresse de l'hébergeur" />, téléphone :{" "}
          <Fill value={HOST.phone} what="numéro de téléphone de l'hébergeur, d'après ses propres mentions légales" />.{" "}
          {HOST.detail}
        </li>
      </ul>
      <p>La base de données est hébergée par :</p>
      <ul>
        <li>
          <strong>{DATABASE_HOST.name}</strong>, <Fill value={DATABASE_HOST.address} what="adresse de l'entité contractante Supabase (voir son DPA)" />.{" "}
          {DATABASE_HOST.detail}
        </li>
      </ul>
      <p>
        Les conversations sont chiffrées au repos. Les autres prestataires qui traitent des données pour
        le compte de l&apos;éditeur sont listés dans la{" "}
        <a href="/legal/confidentialite">politique de confidentialité</a>.
      </p>

      <h2>4. Signalement de contenus et point de contact</h2>
      <p>
        Tout contenu publié par un utilisateur au moyen d&apos;un lien public peut être signalé par le lien
        « Report » présent au pied de la page concernée. Le point de contact unique pour les signalements,
        les utilisateurs et les autorités au titre du règlement (UE) 2022/2065 sur les services numériques
        (articles 11, 12 et 16) est :{" "}
        <Fill value={DSA_CONTACT ?? SELLER.email} what="adresse e-mail du point de contact (signalements et autorités)" />.
        Langues acceptées : français, anglais. Les modalités sont décrites à l&apos;article 9 des{" "}
        <a href="/legal/cgu">CGU</a>.
      </p>

      <h2>5. Médiation de la consommation</h2>
      <p>
        Médiateur de la consommation : <Fill value={MEDIATOR.name} what="nom du médiateur de la consommation" />,{" "}
        <Fill value={MEDIATOR.address} what="adresse du médiateur" />,{" "}
        <Fill value={MEDIATOR.website} what="site internet du médiateur" />. Les conditions de saisine
        figurent à l&apos;article 16 des <a href="/legal/cgv">conditions générales de vente</a>.
      </p>

      <h2>6. Propriété intellectuelle</h2>
      <p>
        {`L'ensemble des éléments composant le service ${PRODUCT_NAME} (interface, textes, marques, logos, éléments graphiques, code) est protégé par le droit de la propriété intellectuelle. Toute reproduction, représentation ou exploitation, totale ou partielle, sans autorisation écrite préalable de l'éditeur est interdite. Les contenus que vous soumettez au service et les réponses générées pour votre compte restent régis par les`}{" "}
        <a href="/legal/cgu">conditions générales d&apos;utilisation</a>.
      </p>

      <h2>7. Données personnelles et cookies</h2>
      <p>
        Le traitement des données personnelles et l&apos;usage des cookies (essentiels uniquement à ce
        jour) sont décrits dans la <a href="/legal/confidentialite">politique de confidentialité</a>.
      </p>

      <h2>8. Droit applicable</h2>
      <p>
        Le service et les présentes mentions légales sont soumis au droit français, dans les conditions
        précisées aux <a href="/legal/cgu">conditions générales d&apos;utilisation</a> et aux{" "}
        <a href="/legal/cgv">conditions générales de vente</a>.
      </p>
    </>
  );
}
