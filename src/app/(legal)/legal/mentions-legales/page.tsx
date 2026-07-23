import type { Metadata } from "next";

/**
 * Mentions légales (LCEN, art. 6-III) — static French legal notice for Juno.
 * The [bracketed] placeholders must be filled in by the site owner before the
 * service is offered commercially.
 */

// Legal pages have no per-user content; force-static keeps them SSG even
// though the root layout reads the session cookie (empty at build time).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Mentions légales",
  description:
    "Mentions légales de Juno (chat.liams.dev) : éditeur, directeur de la publication, hébergeur et propriété intellectuelle, conformément à la loi pour la confiance dans l'économie numérique (LCEN).",
};

export default function MentionsLegalesPage() {
  return (
    <>
      <p className="font-mono text-xs font-medium text-muted-foreground">Juno · Informations légales</p>
      <h1 className="mt-3">Mentions légales</h1>
      <p className="text-muted-foreground">Dernière mise à jour : 5 juillet 2026.</p>

      <p>
        Conformément aux dispositions des articles 6-III et 19 de la loi n° 2004-575 du 21 juin 2004
        pour la confiance dans l&apos;économie numérique (LCEN), les présentes mentions légales sont
        portées à la connaissance des utilisateurs du service Juno, accessible à l&apos;adresse{" "}
        <strong>chat.liams.dev</strong>.
      </p>

      <h2>1. Éditeur du service</h2>
      <p>
        Le service Juno est édité par <strong>[Nom et prénom, ou raison sociale]</strong>,{" "}
        <strong>[forme juridique — ex. entrepreneur individuel / SAS au capital de X €]</strong>,
        immatriculé(e) sous le numéro SIREN <strong>[SIREN]</strong>, dont le siège est situé{" "}
        <strong>[Adresse complète]</strong>.
      </p>
      <ul>
        <li>Adresse électronique de contact : <strong>[adresse e-mail de contact]</strong></li>
        <li>Numéro de TVA intracommunautaire (le cas échéant) : <strong>[N° TVA]</strong></li>
      </ul>

      <h2>2. Directeur de la publication</h2>
      <p>
        Le directeur de la publication est <strong>[Nom et prénom du directeur de la publication]</strong>,
        en qualité de <strong>[qualité — ex. éditeur du service]</strong>.
      </p>

      <h2>3. Hébergement</h2>
      <p>
        Le service est hébergé sur une machine virtuelle fournie par{" "}
        <strong>[Hébergeur — ex. Google Cloud Platform (Google Cloud EMEA Limited), 70 Sir John
        Rogerson&apos;s Quay, Dublin 2, Irlande — préciser raison sociale, adresse et téléphone]</strong>.
      </p>
      <p>
        Les conversations sont chiffrées au repos sur nos serveurs. Les modalités de traitement des
        données personnelles sont détaillées dans la{" "}
        <a href="/legal/confidentialite">politique de confidentialité</a>.
      </p>

      <h2>4. Propriété intellectuelle</h2>
      <p>
        L&apos;ensemble des éléments composant le service Juno (interface, textes, marques, logos,
        éléments graphiques, code) est protégé par le droit de la propriété intellectuelle. Toute
        reproduction, représentation ou exploitation, totale ou partielle, sans autorisation écrite
        préalable de l&apos;éditeur est interdite. Les contenus que vous soumettez au service et les
        réponses générées pour votre compte restent régis par les{" "}
        <a href="/legal/cgu">conditions générales d&apos;utilisation</a>.
      </p>

      <h2>5. Données personnelles et cookies</h2>
      <p>
        Le traitement des données personnelles et l&apos;usage des cookies (essentiels uniquement à ce
        jour) sont décrits dans la <a href="/legal/confidentialite">politique de confidentialité</a>.
        Vous pouvez exercer vos droits (accès, rectification, effacement, portabilité) directement
        depuis votre compte ou en contactant l&apos;éditeur à l&apos;adresse indiquée ci-dessus.
      </p>

      <h2>6. Droit applicable</h2>
      <p>
        Le service et les présentes mentions légales sont soumis au droit français. En cas de litige
        et à défaut de résolution amiable, les tribunaux français seront seuls compétents, dans les
        conditions précisées aux <a href="/legal/cgu">conditions générales</a>.
      </p>
    </>
  );
}
