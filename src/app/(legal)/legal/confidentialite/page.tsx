import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { PROVIDERS } from "@/lib/providers";
import { DATABASE_HOST, HOST, PRIVACY_CONTACT, SELLER, SERVICE_HOST } from "@/lib/legal/seller";
import { Fill } from "@/components/legal/fill";

/**
 * Politique de confidentialité (RGPD art. 13-14) — French privacy notice.
 *
 * The recipients list follows docs/SUBPROCESSORS.md (derived from the code),
 * and the model providers are read from PROVIDERS so a new lab cannot be
 * added to the picker without appearing here. Owner-only facts render as
 * "[À COMPLÉTER : …]" from src/lib/legal/seller.ts. Whether each provider has
 * signed a DPA and SCCs is a question of fact the owner must settle
 * (docs/pricing/LEGAL_CHECKLIST.md); this page says what the safeguard is
 * meant to be, not that it is in place where that is unknown.
 */

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Politique de confidentialité",
  description: `Politique de confidentialité de ${PRODUCT_NAME} (${SERVICE_HOST}) : données collectées, finalités, bases légales, sous-traitants, transferts hors de l'UE, durées de conservation et droits RGPD.`,
};

/** Where each model provider is established, for the transfer column. */
const PROVIDER_REGION: Record<string, string> = {
  anthropic: "États-Unis",
  openai: "États-Unis",
  google: "États-Unis",
  meta: "États-Unis",
  xai: "États-Unis",
  mistral: "France (UE)",
  seedance: "Chine / Singapour",
  zhipu: "Chine",
  moonshot: "Chine",
  deepseek: "Chine",
  minimax: "Chine",
  mimo: "Chine",
  qwen: "Chine (point d'accès international à Singapour)",
  longcat: "Chine",
};

function safeguardFor(region: string): string {
  if (region.includes("UE")) return "Aucun transfert hors UE";
  if (region.startsWith("États-Unis")) {
    return "Décision d'adéquation (Data Privacy Framework) si le fournisseur est certifié, à défaut clauses contractuelles types";
  }
  return "Clauses contractuelles types et analyse d'impact du transfert (aucune décision d'adéquation)";
}

export default function ConfidentialitePage() {
  const contact = PRIVACY_CONTACT ?? SELLER.email;
  return (
    <>
      <p className="font-mono text-label text-muted-foreground">{`${PRODUCT_NAME} · RGPD`}</p>
      <h1 className="mt-3">Politique de confidentialité</h1>
      <p className="text-muted-foreground">Dernière mise à jour : 4 octobre 2026.</p>

      <p>
        {`La présente politique décrit comment ${PRODUCT_NAME} (le « Service »), accessible à l'adresse`}{" "}
        <strong>{SERVICE_HOST}</strong> et depuis ses applications, traite vos données personnelles,
        conformément au règlement (UE) 2016/679 (« RGPD ») et à la loi n° 78-17 du 6 janvier 1978
        (« Informatique et Libertés »).
      </p>

      <h2>1. Responsable du traitement</h2>
      <p>
        Le responsable du traitement est <Fill value={SELLER.name} what="raison sociale" />, SIREN{" "}
        <Fill value={SELLER.siren} what="numéro SIREN" />, <Fill value={SELLER.address} what="adresse postale" />
        , joignable à <Fill value={contact} what="adresse e-mail pour les questions de données personnelles" />{" "}
        (voir les <a href="/legal/mentions-legales">mentions légales</a>). Aucun délégué à la protection
        des données n&apos;a été désigné à ce jour ; cette adresse est le point de contact pour toute
        question relative à vos données.
      </p>

      <h2>2. Données collectées</h2>
      <ul>
        <li>
          <strong>Compte</strong> : adresse e-mail, nom d&apos;affichage, mot de passe (stocké uniquement
          sous forme hachée) ou identifiant d&apos;un service de connexion tiers (par exemple Google), langue, préférences.
        </li>
        <li>
          <strong>Contenus</strong> : messages, fichiers joints, images, vidéos et sons générés,
          artefacts, mémoire, projets. Les conversations sont <strong>chiffrées au repos</strong> et
          privées à votre compte, sauf ce que vous choisissez de partager ou de publier.
        </li>
        <li>
          <strong>Abonnement, facturation et TVA</strong> : offre, statut et dates d&apos;abonnement,
          historique des paiements et factures, nom et adresse de facturation, pays de résidence et, pour
          un professionnel, numéro de TVA. Ces informations sont collectées par Stripe, y compris par
          son service de calcul de taxe (Stripe Tax), pour appliquer le bon taux de TVA (guichet unique
          OSS, autoliquidation). Les données de carte bancaire sont traitées par Stripe et ne transitent
          jamais par nos serveurs.
        </li>
        <li>
          <strong>Parrainage</strong> : lorsque vous parrainez quelqu&apos;un ou êtes parrainé, le lien
          entre les deux comptes, le code utilisé, la date d&apos;inscription et du premier paiement du
          filleul, et les crédits attribués. Votre filleul ne voit pas vos données, et vous ne voyez de
          lui que le fait que le parrainage a abouti.
        </li>
        <li>
          <strong>Données d&apos;usage</strong> : consommation (jetons, coût, modèle utilisé), fenêtres
          d&apos;utilisation, journaux techniques (horodatage, erreurs, adresse IP) nécessaires au
          fonctionnement, à la facturation et à la sécurité.
        </li>
        <li>
          <strong>Signalements</strong> : si vous signalez un contenu publié, le motif, votre message et,
          si vous la donnez, votre adresse e-mail.
        </li>
        <li>
          <strong>Voix</strong> : en mode vocal, l&apos;audio est transmis en temps réel au fournisseur
          vocal sélectionné pour être transcrit ou traité.
        </li>
        <li>
          <strong>Cookies</strong> : uniquement des cookies strictement nécessaires (session, sécurité).
        </li>
      </ul>

      <h2>3. Finalités et bases légales</h2>
      <ul>
        <li>
          <strong>Fournir le Service</strong> (compte, conversations, génération de réponses, mémoire,
          partage, support) — exécution du contrat (CGU et CGV).
        </li>
        <li>
          <strong>Facturer, calculer et déclarer la TVA, tenir la comptabilité, conserver les factures</strong>{" "}
          — exécution du contrat et obligations légales (code de commerce, code général des impôts).
        </li>
        <li>
          <strong>Informer avant la reconduction d&apos;un abonnement annuel</strong> et confirmer une
          résiliation — obligation légale (articles L. 215-1 et L. 215-1-1 du code de la consommation).
        </li>
        <li>
          <strong>Gérer le parrainage</strong> et attribuer les crédits — exécution du contrat (conditions
          du programme) ; <strong>prévenir la fraude au parrainage</strong> — intérêt légitime.
        </li>
        <li>
          <strong>Sécurité, prévention des abus, limites d&apos;utilisation</strong> — intérêt légitime
          à protéger le Service et ses utilisateurs.
        </li>
        <li>
          <strong>Traiter les signalements de contenus publiés</strong> — obligation légale (règlement
          (UE) 2022/2065 sur les services numériques).
        </li>
        <li>
          <strong>Informations commerciales par e-mail</strong>, le cas échéant : à un client, sur des
          services analogues, sauf opposition (vous pouvez vous désinscrire à chaque envoi) ; à toute
          autre personne, uniquement avec son consentement préalable.
        </li>
      </ul>
      <p>
        Vos contenus ne sont pas utilisés pour entraîner des modèles par l&apos;éditeur. Le Service ne prend
        aucune décision produisant des effets juridiques à votre égard sur le seul fondement d&apos;un
        traitement automatisé (article 22 du RGPD).
      </p>

      <h2>4. Destinataires et sous-traitants</h2>
      <p>
        Vos données sont traitées par l&apos;éditeur et, pour son compte, par les sous-traitants suivants,
        liés par un contrat de sous-traitance conforme à l&apos;article 28 du RGPD :
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th scope="col">Sous-traitant</th>
              <th scope="col">Rôle</th>
              <th scope="col">Localisation</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{HOST.name}</td>
              <td>Hébergement de l&apos;application, du relais vocal et des fichiers</td>
              <td>Suède (UE)</td>
            </tr>
            <tr>
              <td>{DATABASE_HOST.name}</td>
              <td>Base de données (comptes, conversations chiffrées)</td>
              <td>Irlande (UE) ; société établie aux États-Unis</td>
            </tr>
            <tr>
              <td>Stripe Payments Europe, Ltd.</td>
              <td>Paiement, abonnements, factures, calcul de la TVA (Stripe Tax)</td>
              <td>Irlande (UE) ; transferts vers les États-Unis</td>
            </tr>
            <tr>
              <td>Resend</td>
              <td>Envoi des e-mails transactionnels (connexion, factures, rappels)</td>
              <td>États-Unis</td>
            </tr>
            <tr>
              <td>Tavily</td>
              <td>Recherche web et recherche approfondie (reçoit la requête)</td>
              <td>États-Unis</td>
            </tr>
            <tr>
              <td>Composio</td>
              <td>Connexion aux applications tierces que vous activez (reçoit les paramètres de l&apos;action)</td>
              <td>États-Unis</td>
            </tr>
            <tr>
              <td>Deepgram, ElevenLabs, OpenAI, Google</td>
              <td>Dictée, lecture à voix haute et mode vocal, selon la configuration</td>
              <td>États-Unis</td>
            </tr>
            <tr>
              <td>Apple</td>
              <td>Notifications push et, si vous y souscrivez, abonnements via l&apos;App Store</td>
              <td>Irlande (UE) / États-Unis</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <strong>Fournisseurs de modèles d&apos;IA.</strong> Pour produire une réponse, le contenu de votre
        demande (texte, pièces jointes nécessaires, contexte de la conversation) est transmis à l&apos;API
        du laboratoire dont vous avez choisi le modèle — ou que le routage automatique a choisi pour vous,
        le modèle utilisé étant toujours affiché. Votre identité de compte ne leur est pas transmise. Les
        fournisseurs proposés sont :
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th scope="col">Fournisseur</th>
              <th scope="col">Établissement</th>
              <th scope="col">Garantie du transfert</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(PROVIDERS).map(([id, provider]) => {
              const region = PROVIDER_REGION[id] ?? "[À COMPLÉTER : pays]";
              return (
                <tr key={id}>
                  <td translate="no">{provider.label}</td>
                  <td>{region}</td>
                  <td>{safeguardFor(region)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        Lorsque vous connectez une application tierce (GitHub, Notion, Figma, Google, etc.), les données
        échangées avec elle le sont à votre demande et selon ses propres conditions. Lorsque vous partagez
        ou publiez un contenu par un lien public, toute personne disposant du lien peut le voir.
      </p>

      <h2>5. Transferts hors de l&apos;Union européenne</h2>
      <p>
        Certains destinataires sont établis hors de l&apos;Union européenne. Les transferts vers les
        États-Unis reposent sur la décision d&apos;adéquation de la Commission européenne du 10 juillet
        2023 (EU-US Data Privacy Framework) pour les sociétés certifiées, et à défaut sur les clauses
        contractuelles types de la Commission (décision 2021/914). Les transferts vers la Chine et
        Singapour, pays qui ne bénéficient pas d&apos;une décision d&apos;adéquation, reposent sur les clauses
        contractuelles types complétées d&apos;une analyse d&apos;impact du transfert. Pour limiter ces
        transferts, choisissez un modèle d&apos;un fournisseur établi dans l&apos;Union (Mistral). Vous pouvez
        obtenir une copie des garanties en écrivant à{" "}
        <Fill value={contact} what="adresse e-mail pour les questions de données personnelles" />.
      </p>

      <h2>6. Durées de conservation</h2>
      <ul>
        <li>
          <strong>Compte et contenus</strong> : tant que le compte est actif. La suppression d&apos;une
          conversation ou du compte efface immédiatement les données des systèmes actifs ; des copies
          peuvent subsister dans les sauvegardes jusqu&apos;à leur rotation{" "}
          (<Fill value={null} what="durée de rotation des sauvegardes Supabase, en jours" />), puis sont
          détruites.
        </li>
        <li>
          <strong>Factures et pièces comptables</strong> : dix ans à compter de la clôture de
          l&apos;exercice (article L. 123-22 du code de commerce), y compris les données de TVA.
        </li>
        <li>
          <strong>Contrat d&apos;un montant d&apos;au moins 120 €</strong> : dix ans (article L. 213-1 du code
          de la consommation).
        </li>
        <li>
          <strong>Parrainage</strong> : pendant la durée du programme, puis trois ans pour la gestion
          d&apos;éventuelles réclamations.
        </li>
        <li>
          <strong>Signalements et décisions de modération</strong> : un an après la clôture du
          signalement, plus longtemps en cas de contentieux.
        </li>
        <li>
          <strong>Journaux techniques</strong> : douze mois au maximum.
        </li>
        <li>
          <strong>Prospects</strong> (personne ayant demandé à être informée sans créer de compte) : trois
          ans après le dernier contact.
        </li>
      </ul>

      <h2>7. Vos droits</h2>
      <ul>
        <li>
          <strong>Accès et rectification</strong> : vos informations de compte sont consultables et
          modifiables dans les réglages du Service.
        </li>
        <li>
          <strong>Effacement</strong> : la suppression de compte intégrée (Réglages → Compte) efface votre
          compte et vos contenus ; chaque conversation peut aussi être supprimée individuellement. Les
          données de facturation sont conservées pour la durée légale.
        </li>
        <li>
          <strong>Portabilité</strong> : la fonction d&apos;export intégrée fournit vos données dans un
          format structuré et lisible par machine.
        </li>
        <li>
          <strong>Opposition, limitation, retrait du consentement</strong> : à tout moment, en écrivant à{" "}
          <Fill value={contact} what="adresse e-mail pour les questions de données personnelles" />.
        </li>
        <li>
          <strong>Directives post mortem</strong> : vous pouvez définir des directives relatives au sort de
          vos données après votre décès (article 85 de la loi Informatique et Libertés).
        </li>
        <li>
          <strong>Réclamation</strong> : auprès de la Commission nationale de l&apos;informatique et des
          libertés (CNIL), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07 —{" "}
          <a href="https://www.cnil.fr" rel="noopener noreferrer">www.cnil.fr</a>.
        </li>
      </ul>
      <p>Nous répondons à toute demande dans un délai d&apos;un mois.</p>

      <h2>8. Cookies</h2>
      <p>
        Le Service dépose uniquement des cookies strictement nécessaires (authentification et sécurité
        de session), exemptés de consentement. Aucun cookie publicitaire ou de mesure d&apos;audience
        n&apos;est utilisé ; si cela devait changer, votre consentement serait recueilli au préalable.
      </p>

      <h2>9. Sécurité</h2>
      <p>
        Les échanges sont chiffrés en transit (TLS) et les conversations chiffrées au repos. Les mots de
        passe sont stockés sous forme hachée. L&apos;accès aux données de production est strictement
        restreint. En cas de violation de données présentant un risque, la CNIL et, le cas échéant, les
        personnes concernées sont notifiées dans les conditions des articles 33 et 34 du RGPD.
      </p>

      <h2>10. Mineurs</h2>
      <p>
        Le Service est réservé aux personnes de 15 ans et plus ; en dessous, le consentement conjoint
        d&apos;un titulaire de l&apos;autorité parentale est requis (article 45 de la loi Informatique et
        Libertés).
      </p>

      <h2>11. Contact</h2>
      <p>
        Pour toute question relative à cette politique ou à vos données :{" "}
        <Fill value={contact} what="adresse e-mail pour les questions de données personnelles" />.
      </p>
    </>
  );
}
