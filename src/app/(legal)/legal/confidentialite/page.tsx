import type { Metadata } from "next";

/**
 * Politique de confidentialité (RGPD) — static French privacy policy for Juno.
 * The [bracketed] placeholders must be filled in by the site owner.
 */

// Legal pages have no per-user content; force-static keeps them SSG even
// though the root layout reads the session cookie (empty at build time).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Politique de confidentialité",
  description:
    "Politique de confidentialité de Juno (chat.liams.dev) : données collectées, finalités, bases légales, durées de conservation, sous-traitants et droits RGPD (accès, rectification, effacement, portabilité, réclamation CNIL).",
};

export default function ConfidentialitePage() {
  return (
    <>
      <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Juno · RGPD</p>
      <h1 className="mt-3">Politique de confidentialité</h1>
      <p className="text-muted-foreground">Dernière mise à jour : 5 juillet 2026.</p>

      <p>
        La présente politique décrit comment Juno (le « Service »), accessible à l&apos;adresse{" "}
        <strong>chat.liams.dev</strong>, traite vos données personnelles, conformément au règlement
        (UE) 2016/679 (« RGPD ») et à la loi Informatique et Libertés.
      </p>

      <h2>1. Responsable du traitement</h2>
      <p>
        Le responsable du traitement est <strong>[Nom et prénom, ou raison sociale]</strong>, SIREN{" "}
        <strong>[SIREN]</strong>, <strong>[Adresse complète]</strong>, joignable à{" "}
        <strong>[adresse e-mail de contact]</strong> (voir les{" "}
        <a href="/legal/mentions-legales">mentions légales</a>).
      </p>

      <h2>2. Données collectées</h2>
      <ul>
        <li>
          <strong>Données de compte</strong> : adresse e-mail, nom d&apos;affichage, mot de passe (stocké
          exclusivement sous forme hachée), plan d&apos;abonnement.
        </li>
        <li>
          <strong>Conversations et contenus</strong> : messages, fichiers joints et artefacts que vous
          créez dans le Service. Les conversations sont <strong>chiffrées au repos</strong> sur nos
          serveurs et privées à votre compte.
        </li>
        <li>
          <strong>Données d&apos;usage</strong> : compteurs de messages et de budget, modèle utilisé,
          journaux techniques (horodatage, erreurs) nécessaires au fonctionnement, à la facturation et
          à la sécurité du Service.
        </li>
        <li>
          <strong>Cookies</strong> : uniquement des <strong>cookies essentiels</strong> (session de
          connexion, sécurité). Aucun cookie publicitaire ni de mesure d&apos;audience n&apos;est déposé à ce
          jour ; tout ajout futur sera soumis à votre consentement via le bandeau dédié.
        </li>
      </ul>

      <h2>3. Finalités et bases légales</h2>
      <ul>
        <li>
          <strong>Fourniture du Service</strong> (compte, conversations, génération de réponses par les
          modèles d&apos;IA, support) — base légale : exécution du contrat (CGU).
        </li>
        <li>
          <strong>Facturation et gestion des abonnements</strong> — base légale : exécution du contrat
          et obligations légales (comptabilité).
        </li>
        <li>
          <strong>Sécurité, prévention des abus et amélioration du Service</strong> (journaux
          techniques, quotas) — base légale : intérêt légitime du responsable du traitement.
        </li>
        <li>
          <strong>Cookies non essentiels éventuels</strong> — base légale : consentement, recueilli et
          révocable via le bandeau de consentement.
        </li>
      </ul>

      <h2>4. Destinataires et sous-traitants</h2>
      <p>Vos données sont traitées par l&apos;éditeur et, pour son compte, par des sous-traitants :</p>
      <ul>
        <li>
          <strong>Hébergeur</strong> : <strong>[Hébergeur — ex. Google Cloud Platform, machine
          virtuelle localisée à préciser]</strong>, qui héberge l&apos;application et la base de données
          (conversations chiffrées au repos).
        </li>
        <li>
          <strong>Stripe</strong> (Stripe Payments Europe, Ltd.) : traitement des paiements. Vos
          données bancaires sont transmises directement à Stripe et ne transitent jamais par nos
          serveurs.
        </li>
        <li>
          <strong>Fournisseurs de modèles d&apos;IA</strong> : pour générer une réponse, le contenu de vos
          messages (« prompts ») et les pièces jointes nécessaires sont <strong>transmis aux API des
          laboratoires d&apos;IA correspondant aux modèles que vous sélectionnez</strong> (par exemple
          Anthropic, OpenAI, Google, ou d&apos;autres fournisseurs proposés dans le Service). Ces
          fournisseurs traitent ces contenus selon leurs propres conditions ; nous ne leur transmettons
          pas votre identité de compte.
        </li>
      </ul>
      <p>
        Certains de ces sous-traitants peuvent traiter des données en dehors de l&apos;Union européenne ;
        ces transferts sont encadrés par des garanties appropriées (clauses contractuelles types de la
        Commission européenne ou mécanismes d&apos;adéquation équivalents).
      </p>

      <h2>5. Durées de conservation</h2>
      <ul>
        <li>
          <strong>Compte et conversations</strong> : conservés tant que votre compte est actif. La
          suppression d&apos;une conversation ou du compte entraîne l&apos;effacement immédiat des données
          associées de nos systèmes actifs ; des copies résiduelles peuvent subsister dans nos
          sauvegardes de base de données jusqu&apos;à leur rotation, puis sont définitivement détruites.
          Stripe conserve par ailleurs ses propres enregistrements de paiement conformément à ses
          obligations légales.
        </li>
        <li>
          <strong>Données de facturation</strong> : conservées pendant les durées légales applicables
          (10 ans pour les pièces comptables).
        </li>
        <li>
          <strong>Journaux techniques</strong> : conservés au maximum 12 mois.
        </li>
      </ul>

      <h2>6. Vos droits</h2>
      <p>Conformément au RGPD, vous disposez des droits suivants :</p>
      <ul>
        <li>
          <strong>Accès et rectification</strong> : vos informations de compte sont consultables et
          modifiables directement dans les réglages du Service.
        </li>
        <li>
          <strong>Effacement</strong> : la <strong>suppression de compte intégrée</strong> (Réglages →
          Compte) efface votre compte et vos conversations. Vous pouvez également supprimer chaque
          conversation individuellement.
        </li>
        <li>
          <strong>Portabilité</strong> : la fonction d&apos;<strong>export intégrée</strong> vous permet de
          récupérer vos données dans un format structuré et lisible par machine.
        </li>
        <li>
          <strong>Opposition et limitation</strong> : vous pouvez vous opposer aux traitements fondés
          sur l&apos;intérêt légitime ou en demander la limitation en écrivant à{" "}
          <strong>[adresse e-mail de contact]</strong>.
        </li>
        <li>
          <strong>Réclamation</strong> : vous pouvez saisir la Commission nationale de l&apos;informatique
          et des libertés (CNIL), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07 —{" "}
          <a href="https://www.cnil.fr" rel="noopener noreferrer">www.cnil.fr</a>.
        </li>
      </ul>

      <h2>7. Cookies</h2>
      <p>
        Le Service dépose uniquement des cookies strictement nécessaires (authentification et
        sécurité de session), exemptés de consentement. Un bandeau vous permet néanmoins d&apos;enregistrer
        votre choix concernant d&apos;éventuels cookies de mesure d&apos;audience futurs ; aucun de ces cookies
        ne sera déposé sans votre accord préalable, et vous pourrez retirer ce consentement à tout
        moment.
      </p>

      <h2>8. Sécurité</h2>
      <p>
        Les échanges avec le Service sont chiffrés en transit (TLS) et les conversations sont
        chiffrées au repos. Les mots de passe sont stockés sous forme hachée. L&apos;accès aux données de
        production est strictement restreint.
      </p>

      <h2>9. Contact</h2>
      <p>
        Pour toute question relative à cette politique ou à vos données :{" "}
        <strong>[adresse e-mail de contact]</strong>.
      </p>
    </>
  );
}
