import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { PLAN_LIST, type PlanConfig } from "@/lib/plans";
import { ANNUAL_MONTHS_BILLED, DISPLAY_VAT_RATE, displayPrice } from "@/lib/price-display";
import { budgetForPlan } from "@/lib/spend";
import { MEDIATOR, SELLER, SERVICE_HOST } from "@/lib/legal/seller";
import { Fill } from "@/components/legal/fill";

/**
 * Conditions générales de vente (CGV) — the consumer contract of sale.
 *
 * Every price on this page is computed from PLANS (src/lib/plans.ts) through
 * displayPrice() (src/lib/price-display.ts), the same path the pricing page
 * and checkout read, so the contract cannot drift from what is charged. The
 * usage index is computed from the enforced budgets (budgetForPlan in
 * src/lib/spend.ts) for the same reason. The seller's identity and the
 * mediator come from src/lib/legal/seller.ts and render as visible
 * "[À COMPLÉTER : …]" markers until the owner fills them in.
 *
 * The withdrawal clause (art. 10) matches, word for word in substance, the
 * consent checkbox Stripe Checkout shows (src/app/api/stripe/checkout/route.ts).
 * Change one, change the other.
 *
 * Draft written against the Code de la consommation as in force on
 * 4 October 2026. It is not legal advice: have it reviewed before selling.
 */

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Conditions générales de vente (CGV)",
  description: `Conditions générales de vente de ${PRODUCT_NAME} : offres et prix TTC, limites d'utilisation, paiement, renouvellement, résiliation, droit de rétractation, garanties légales, médiation et droit applicable.`,
};

const LAST_UPDATED = "4 octobre 2026";
const VAT_PERCENT = `${Math.round(DISPLAY_VAT_RATE * 100)} %`;

/** The plans someone can buy, cheapest first. Free is described separately. */
const PAID = PLAN_LIST.filter((p) => p.price > 0);

/** Usage volume relative to Pro (Pro = 100), from the budgets the meter enforces. */
function usageIndex(plan: PlanConfig): string {
  const pro = budgetForPlan("PRO");
  const mine = budgetForPlan(plan.id);
  if (!pro || mine == null) return "—";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format((mine / pro) * 100);
}

function yesNo(value: boolean): string {
  return value ? "Oui" : "Non";
}

const FREE = PLAN_LIST.find((p) => p.id === "FREE");

export default function CgvPage() {
  return (
    <>
      <p className="font-mono text-label text-muted-foreground">{`${PRODUCT_NAME} · Conditions de vente`}</p>
      <h1 className="mt-3">Conditions générales de vente</h1>
      <p className="text-muted-foreground">Dernière mise à jour : {LAST_UPDATED}.</p>

      <p>
        {`Les présentes conditions générales de vente (les « CGV ») s'appliquent à tout abonnement et à tout achat de crédit d'utilisation du service ${PRODUCT_NAME} (le « Service »), accessible à l'adresse `}
        <strong>{SERVICE_HOST}</strong> et depuis ses applications. Elles complètent les{" "}
        <a href="/legal/cgu">conditions générales d&apos;utilisation</a> (les « CGU »), qui régissent
        l&apos;usage du Service ; en cas de contradiction sur la vente, le prix, la rétractation ou la
        résiliation, les présentes CGV prévalent.
      </p>

      <h2>1. Le vendeur</h2>
      <p>Le Service est vendu par :</p>
      <ul>
        <li>
          Dénomination : <Fill value={SELLER.name} what="raison sociale, ou nom et prénom de l'entrepreneur individuel" />
        </li>
        <li>
          Forme juridique : <Fill value={SELLER.legalForm} what="forme juridique (SASU, EURL, entrepreneur individuel…)" />
          {" "}— capital social : <Fill value={SELLER.shareCapital} what="montant du capital social, sauf entrepreneur individuel" />
        </li>
        <li>
          Immatriculation : SIREN <Fill value={SELLER.siren} what="numéro SIREN" />,{" "}
          <Fill value={SELLER.registry} what="RCS de la ville du greffe, ou RNE" />
        </li>
        <li>
          Siège : <Fill value={SELLER.address} what="adresse postale complète" />
        </li>
        <li>
          N° de TVA intracommunautaire : <Fill value={SELLER.vatNumber} what="numéro de TVA FR…" />
        </li>
        <li>
          Contact : <Fill value={SELLER.email} what="adresse e-mail du service client" /> — téléphone :{" "}
          <Fill value={SELLER.phone} what="numéro de téléphone" />
        </li>
      </ul>
      <p>
        Les autres informations légales figurent dans les{" "}
        <a href="/legal/mentions-legales">mentions légales</a>.
      </p>

      <h2>2. Champ d&apos;application et acceptation</h2>
      <p>
        Les CGV s&apos;appliquent aux consommateurs et aux non-professionnels. Les clauses propres aux
        clients professionnels sont signalées comme telles. Elles sont rédigées en français, qui est la
        langue du contrat. Elles sont acceptées au moment de la commande, par une case à cocher
        obligatoire sur la page de paiement ; la version applicable est celle en vigueur à la date de la
        commande, que vous pouvez enregistrer ou imprimer depuis cette page.
      </p>
      <p>
        Lorsque le montant d&apos;une commande atteint ou dépasse 120 € TTC (par exemple un abonnement
        annuel), le vendeur conserve l&apos;écrit constatant le contrat pendant dix ans et vous en garantit
        l&apos;accès sur simple demande (articles L. 213-1 et D. 213-1 du code de la consommation).
      </p>

      <h2>3. Les offres</h2>
      <p>
        {`${PRODUCT_NAME} donne accès, depuis une interface unique, à des modèles d'intelligence artificielle de plusieurs fournisseurs (texte, code, images, vidéo, audio selon l'offre) et aux fonctions associées (projets, mémoire, artefacts, recherche, agents). Le Service est proposé selon les offres ci-dessous. Leurs caractéristiques essentielles sont :`}
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th scope="col">Offre</th>
              <th scope="col">Volume (Pro = 100)</th>
              <th scope="col">Web</th>
              <th scope="col">Code et agents</th>
              <th scope="col">Voix</th>
              <th scope="col">Fichiers</th>
            </tr>
          </thead>
          <tbody>
            {PLAN_LIST.map((plan) => (
              <tr key={plan.id}>
                <td translate="no">{plan.name}</td>
                <td className="tabular-nums">{usageIndex(plan)}</td>
                <td>{yesNo(plan.webSearch)}</td>
                <td>{yesNo(plan.code && plan.agents && plan.research)}</td>
                <td>{yesNo(plan.voice)}</td>
                <td className="tabular-nums">{`${plan.maxUploadMb} Mo`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul>
        <li>
          <strong>Offre {FREE?.name ?? "Free"}</strong> : gratuite, sans moyen de paiement. Elle comprend une
          petite allocation mensuelle utilisable uniquement avec les modèles les plus économiques ;
          elle ne comprend ni la recherche web, ni le mode vocal, ni Code, ni les agents, ni la recherche
          approfondie.
        </li>
        <li>
          <strong>Offres payantes</strong> : chaque offre donne accès aux modèles indiqués sur la page
          d&apos;abonnement du Service. Lite donne accès aux modèles rapides du quotidien ; à partir de Pro,
          tous les modèles du catalogue ainsi que Code, les agents et la recherche approfondie sont
          inclus. La colonne « Volume » compare le volume d&apos;utilisation mensuel de chaque offre à celui
          de l&apos;offre Pro (indice 100) ; « Web » désigne la recherche web, « Code et agents » le
          produit Code, les agents et la recherche approfondie, « Voix » le mode vocal, et « Fichiers »
          la taille maximale d&apos;un fichier envoyé.
        </li>
      </ul>
      <p>
        Le Service fonctionne dans un navigateur web récent et dans les applications {PRODUCT_NAME} pour
        macOS et iOS lorsqu&apos;elles sont proposées. Il est fourni dès la confirmation du paiement.
      </p>

      <h2>4. Prix</h2>
      <p>
        Les prix sont exprimés en euros, <strong>toutes taxes comprises (TTC)</strong> pour un client
        établi en France, TVA française de {VAT_PERCENT} incluse. Le montant hors taxes (HT) est indiqué
        pour information.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th scope="col">Offre</th>
              <th scope="col">Mensuel TTC</th>
              <th scope="col">Mensuel HT</th>
              <th scope="col">Annuel TTC</th>
              <th scope="col">Annuel, soit par mois TTC</th>
            </tr>
          </thead>
          <tbody>
            {FREE && (
              <tr>
                <td translate="no">{FREE.name}</td>
                <td>Gratuit</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
              </tr>
            )}
            {PAID.map((plan) => {
              const price = displayPrice(plan.price, "fr");
              return (
                <tr key={plan.id}>
                  <td translate="no">{plan.name}</td>
                  <td className="tabular-nums">{price.monthly}</td>
                  <td className="tabular-nums">{price.monthlyHt}</td>
                  <td className="tabular-nums">{price.yearly}</td>
                  <td className="tabular-nums">{price.yearlyPerMonth}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul>
        <li>
          <strong>Facturation annuelle</strong> : douze mois de Service pour le prix de{" "}
          {ANNUAL_MONTHS_BILLED} mois, payés en une fois au début de la période.
        </li>
        <li>
          <strong>Consommateurs d&apos;un autre État membre de l&apos;Union européenne</strong> : la TVA
          appliquée est celle de votre pays de résidence (guichet unique OSS), si bien que le prix TTC
          peut différer de celui affiché ci-dessus. Le montant exact est affiché sur la page de paiement
          avant toute validation.
        </li>
        <li>
          <strong>Clients professionnels</strong> : un professionnel établi en France paie la TVA
          française. Un professionnel établi dans un autre État membre qui fournit un numéro de TVA
          intracommunautaire valide est facturé hors taxes, la TVA étant autoliquidée par le preneur
          (article 196 de la directive 2006/112/CE). Hors de l&apos;Union européenne, les règles du pays
          du client s&apos;appliquent ; le montant dû est affiché avant le paiement.
        </li>
        <li>
          Les codes promotionnels éventuels s&apos;appliquent dans les conditions indiquées lors de leur
          communication.
        </li>
      </ul>

      <h2>5. Limites d&apos;utilisation</h2>
      <p>
        Chaque offre comprend un <strong>volume d&apos;utilisation mensuel</strong>. Ce volume est mesuré en
        jetons (« tokens », les unités de texte traitées par les modèles), pondérés par le coût de chaque
        modèle : une même conversation consomme davantage sur un modèle plus puissant, et les images, les
        vidéos, l&apos;audio, la recherche web et les tâches d&apos;agents consomment également ce volume.
      </p>
      <ul>
        <li>
          <strong>Mensuel</strong> : le volume est rechargé au début de chaque période de facturation
          (chaque mois, y compris pour un abonnement annuel). Le volume non utilisé n&apos;est pas reporté.
        </li>
        <li>
          <strong>Fenêtres glissantes</strong> : pour répartir la capacité entre tous les utilisateurs, la
          consommation est aussi limitée sur une fenêtre de <strong>5 heures</strong> et sur une fenêtre de{" "}
          <strong>7 jours</strong>. Lorsqu&apos;une fenêtre est atteinte, l&apos;envoi de nouvelles demandes est
          suspendu jusqu&apos;à sa réinitialisation, dont l&apos;heure est affichée.
        </li>
        <li>
          <strong>Transparence</strong> : la consommation en cours, le volume restant et l&apos;heure de
          réinitialisation de chaque fenêtre sont affichés en permanence dans Réglages → Plan &amp; usage.
          Vous pouvez y fixer vous-même un plafond mensuel plus bas.
        </li>
        <li>
          <strong>Au-delà</strong> : lorsque le volume mensuel est épuisé, vous pouvez attendre la période
          suivante, passer à une offre supérieure ou acheter un crédit d&apos;utilisation supplémentaire
          (article 6). Aucun dépassement n&apos;est jamais facturé sans action de votre part.
        </li>
      </ul>
      <p>
        Ces limites font partie des caractéristiques de l&apos;offre ; elles ne constituent pas un défaut de
        conformité. Le contournement des limites (comptes multiples, automatisation massive, revente de
        l&apos;accès) est interdit par les <a href="/legal/cgu">CGU</a>.
      </p>

      <h2>6. Crédits d&apos;utilisation supplémentaires et parrainage</h2>
      <p>
        Lorsque le Service les propose, des <strong>recharges</strong> permettent d&apos;acheter, en une fois
        et sans abonnement supplémentaire, un volume d&apos;utilisation qui s&apos;ajoute à celui de votre
        offre. Le prix TTC de chaque recharge et le volume qu&apos;elle apporte sont affichés avant
        l&apos;achat. Le crédit acheté est utilisable pendant <strong>12 mois</strong> à compter de
        l&apos;achat ; il n&apos;est ni remboursable (hors droit de rétractation et garanties légales), ni
        convertible en argent, ni cessible.
      </p>
      <p>
        Le <strong>parrainage</strong>, lorsqu&apos;il est proposé, attribue au parrain et au filleul un
        crédit d&apos;utilisation offert dont le montant et les conditions (notamment le premier paiement
        du filleul) sont affichés dans le Service. Ce crédit est gratuit, sans valeur monétaire,
        non remboursable et non cessible ; il est retiré en cas de fraude (parrainage de soi-même,
        comptes fictifs).
      </p>

      <h2>7. Commande et paiement</h2>
      <p>La commande se déroule ainsi :</p>
      <ul>
        <li>vous choisissez une offre et une périodicité (mensuelle ou annuelle) sur la page d&apos;abonnement ;</li>
        <li>
          vous êtes dirigé vers la page de paiement sécurisée de notre prestataire <strong>Stripe</strong>,
          qui affiche le récapitulatif de la commande et son prix total TTC ; vous y indiquez votre adresse
          de facturation et, pour un professionnel, votre numéro de TVA ;
        </li>
        <li>
          vous acceptez les présentes CGV et formulez la demande d&apos;exécution immédiate décrite à
          l&apos;article 10, puis vous validez la commande par le bouton de paiement, qui vaut obligation de
          paiement ;
        </li>
        <li>
          une confirmation de la commande, reprenant ces informations, vous est adressée par e-mail.
        </li>
      </ul>
      <p>
        Le paiement s&apos;effectue par carte bancaire ou par les autres moyens que Stripe propose sur la
        page de paiement. Il est exigible à la commande puis au début de chaque période de facturation, par
        prélèvement automatique sur le moyen de paiement enregistré. Vos données de paiement sont traitées
        par Stripe et ne transitent jamais par nos serveurs. En cas d&apos;échec de paiement, Stripe procède
        à de nouvelles tentatives ; à défaut de régularisation après notification, l&apos;accès aux
        fonctions payantes est suspendu et le compte revient à l&apos;offre Free.
      </p>
      <p>
        Une facture est émise pour chaque paiement et reste disponible dans l&apos;espace de facturation
        (Réglages → Plan &amp; usage → Manage billing).
      </p>

      <h2>8. Durée et renouvellement</h2>
      <ul>
        <li>
          <strong>Abonnement mensuel</strong> : conclu pour un mois, il est reconduit tacitement de mois en
          mois jusqu&apos;à sa résiliation.
        </li>
        <li>
          <strong>Abonnement annuel</strong> : conclu pour douze mois, il est reconduit tacitement pour une
          nouvelle période de douze mois, sauf résiliation avant son terme. Conformément à
          l&apos;article L. 215-1 du code de la consommation, nous vous informons par un courrier électronique
          dédié, <strong>au plus tôt trois mois et au plus tard un mois</strong> avant la date limite de
          non-reconduction, de la possibilité de ne pas reconduire votre abonnement ; cette information
          mentionne, dans un encadré apparent, cette date limite. À défaut de cette information, vous
          pouvez mettre fin gratuitement au contrat à tout moment à compter de la date de reconduction, et
          les avances versées pour la période postérieure à la résiliation vous sont remboursées dans un
          délai de trente jours (le texte de ces articles est reproduit à l&apos;article 18).
        </li>
        <li>
          <strong>Changement d&apos;offre</strong> : un passage à une offre supérieure prend effet
          immédiatement, la différence étant calculée au prorata par Stripe et affichée avant validation ;
          un passage à une offre inférieure prend effet à la fin de la période en cours.
        </li>
        <li>
          <strong>Évolution des prix</strong> : toute modification de prix vous est notifiée par e-mail au
          moins 30 jours avant son application, ne s&apos;applique qu&apos;à compter de la période suivante et
          vous laisse la possibilité de résilier sans frais avant son entrée en vigueur. Pour un abonnement
          annuel, le prix de la période en cours n&apos;est jamais modifié.
        </li>
      </ul>

      <h2>9. Résiliation</h2>
      <p>
        Vous pouvez résilier votre abonnement à tout moment, gratuitement, en ligne, depuis la fonction{" "}
        <strong>« Résilier votre abonnement »</strong> accessible dans Réglages → Plan &amp; usage
        (article L. 215-1-1 du code de la consommation). Un récapitulatif vous est présenté avant la
        notification de la résiliation, puis un e-mail vous confirme sa réception, la date de fin du
        contrat et ses effets. Vous pouvez aussi résilier depuis l&apos;espace de facturation Stripe ou en
        écrivant au service client.
      </p>
      <p>
        Lors de la résiliation, la fonction vous propose qu&apos;elle prenne effet{" "}
        <strong>à la fin de la période de facturation en cours</strong>, déjà payée : vous conservez
        alors l&apos;accès à votre offre jusqu&apos;à cette date, puis le compte passe à l&apos;offre Free, sans
        perte de vos conversations. En choisissant cette date, vous demandez que la résiliation prenne
        effet plus de dix jours après sa notification, comme le permet l&apos;article L. 224-25-9 du code
        de la consommation. Vous pouvez aussi demander au service client qu&apos;elle prenne effet dans un
        délai de dix jours au plus ; la part du prix correspondant à la période qui ne sera pas fournie
        vous est alors remboursée au prorata.
      </p>
      <p>
        Hors ces cas, la période en cours n&apos;est pas remboursée, sauf exercice du droit de rétractation
        (article 10), manquement du vendeur ou cas prévu par la loi (notamment l&apos;article L. 215-1 pour
        les abonnements annuels). Pour un abonnement annuel, la résiliation empêche la reconduction et
        prend effet au terme de la période annuelle en cours.
      </p>
      <p>
        Un abonnement souscrit via l&apos;App Store d&apos;Apple est facturé et résilié par Apple, depuis les
        réglages d&apos;abonnement de votre identifiant Apple ; les conditions d&apos;Apple s&apos;appliquent
        alors au paiement, au remboursement et à la résiliation.
      </p>
      <p>
        Le vendeur peut résilier le contrat en cas de manquement grave ou répété aux CGU (fraude, usage
        illicite, contournement des limites), après notification motivée, sauf urgence ou obligation
        légale ; la période payée et non consommée est alors remboursée au prorata, sauf fraude.
      </p>

      <h2>10. Droit de rétractation</h2>
      <p>
        Si vous êtes un consommateur, vous disposez d&apos;un délai de <strong>quatorze jours</strong> à
        compter de la conclusion du contrat pour vous rétracter, sans avoir à motiver votre décision ni à
        supporter d&apos;autres coûts que ceux prévus ci-dessous (articles L. 221-18 et suivants du code de
        la consommation).
      </p>
      <p>
        <strong>Exécution immédiate.</strong> Le Service étant fourni dès le paiement, la page de paiement
        vous demande, par une case à cocher obligatoire, d&apos;accepter les CGV et de{" "}
        <strong>
          demander expressément que votre abonnement commence immédiatement, avant la fin du délai de
          rétractation
        </strong>
        , en reconnaissant que vous perdrez votre droit de rétractation une fois le service pleinement
        exécuté (articles L. 221-25 et L. 221-28, 1° du code de la consommation). Cette demande et cette
        reconnaissance vous sont confirmées dans l&apos;e-mail de confirmation de commande.
      </p>
      <p>En conséquence :</p>
      <ul>
        <li>
          vous pouvez vous rétracter pendant les quatorze jours ; vous restez alors redevable d&apos;un
          montant proportionnel au service fourni jusqu&apos;à la communication de votre décision, calculé
          au prorata du nombre de jours écoulés sur la période payée (mois ou année) ;
        </li>
        <li>
          pour un crédit d&apos;utilisation supplémentaire, le montant dû est proportionnel à la part du
          crédit déjà consommée ; un crédit entièrement consommé avant la fin du délai est un service
          pleinement exécuté, pour lequel la rétractation n&apos;est plus possible ;
        </li>
        <li>
          si vous n&apos;avez pas formulé de demande expresse d&apos;exécution immédiate, aucune somme
          n&apos;est due au titre de la période de rétractation.
        </li>
      </ul>
      <p>
        <strong>Comment se rétracter.</strong> Informez-nous de votre décision avant l&apos;expiration du
        délai par une déclaration dénuée d&apos;ambiguïté, par e-mail à{" "}
        <Fill value={SELLER.email} what="adresse e-mail du service client" /> ou par courrier à{" "}
        <Fill value={SELLER.address} what="adresse postale" />, en utilisant si vous le souhaitez le
        formulaire figurant en annexe. Nous en accusons réception sans délai sur un support durable.
      </p>
      <p>
        <strong>Remboursement.</strong> Les sommes versées, déduction faite du montant proportionnel
        ci-dessus, vous sont remboursées au plus tard <strong>quatorze jours</strong> après réception de
        votre décision, par le même moyen de paiement que celui utilisé pour la commande, sans frais
        (article L. 221-24). L&apos;abonnement prend fin à la date de la rétractation.
      </p>
      <p>
        Le droit de rétractation ne s&apos;applique pas aux clients professionnels. Les achats effectués
        via l&apos;App Store relèvent de la procédure de remboursement d&apos;Apple.
      </p>

      <h2>11. Garanties légales</h2>
      <p>
        Le vendeur est tenu de la garantie légale de conformité des contenus numériques et des services
        numériques (articles L. 224-25-12 et suivants du code de la consommation) et de la garantie des
        vices cachés (articles 1641 à 1649 du code civil). Pour la mettre en œuvre, contactez le service
        client à <Fill value={SELLER.email} what="adresse e-mail du service client" />.
      </p>
      <div className="mt-4 rounded-lg border border-border p-5 [&>p:first-child]:mt-0">
        <p>
          Le consommateur a droit à la mise en œuvre de la garantie légale de conformité en cas
          d&apos;apparition d&apos;un défaut de conformité durant un délai de{" "}
          <strong>
            toute la durée de fourniture du service prévue au contrat (la période d&apos;abonnement en cours
            et chacune de ses reconductions)
          </strong>{" "}
          à compter de la fourniture du contenu numérique ou du service numérique. Durant ce délai, le
          consommateur n&apos;est tenu d&apos;établir que l&apos;existence du défaut de conformité et non la date
          d&apos;apparition de celui-ci.
        </p>
        <p>
          La garantie légale de conformité emporte obligation de fournir toutes les mises à jour
          nécessaires au maintien de la conformité du contenu numérique ou du service numérique durant{" "}
          <strong>toute la durée de fourniture du service prévue au contrat</strong>.
        </p>
        <p>
          La garantie légale de conformité donne au consommateur droit à la mise en conformité du contenu
          numérique ou du service numérique sans retard injustifié suivant sa demande, sans frais et sans
          inconvénient majeur pour lui.
        </p>
        <p>
          Le consommateur peut obtenir une réduction du prix en conservant le contenu numérique ou le
          service numérique, ou il peut mettre fin au contrat en se faisant rembourser intégralement contre
          renoncement au contenu numérique ou au service numérique, si :
        </p>
        <p>1° Le professionnel refuse de mettre le contenu numérique ou le service numérique en conformité ;</p>
        <p>2° La mise en conformité du contenu numérique ou du service numérique est retardée de manière injustifiée ;</p>
        <p>3° La mise en conformité du contenu numérique ou du service numérique ne peut intervenir sans frais imposés au consommateur ;</p>
        <p>4° La mise en conformité du contenu numérique ou du service numérique occasionne un inconvénient majeur pour le consommateur ;</p>
        <p>
          5° La non-conformité du contenu numérique ou du service numérique persiste en dépit de la
          tentative de mise en conformité du professionnel restée infructueuse.
        </p>
        <p>
          Le consommateur a également droit à une réduction du prix ou à la résolution du contrat lorsque
          le défaut de conformité est si grave qu&apos;il justifie que la réduction du prix ou la résolution du
          contrat soit immédiate. Le consommateur n&apos;est alors pas tenu de demander la mise en conformité
          du contenu numérique ou du service numérique au préalable.
        </p>
        <p>
          Dans les cas où le défaut de conformité est mineur, le consommateur n&apos;a droit à
          l&apos;annulation du contrat que si le contrat ne prévoit pas le paiement d&apos;un prix.
        </p>
        <p>
          Toute période d&apos;indisponibilité du contenu numérique ou du service numérique en vue de sa
          remise en conformité suspend la garantie qui restait à courir jusqu&apos;à la fourniture du contenu
          numérique ou du service numérique de nouveau conforme.
        </p>
        <p>Ces droits résultent de l&apos;application des articles L. 224-25-1 à L. 224-25-31 du code de la consommation.</p>
        <p>
          Le professionnel qui fait obstacle de mauvaise foi à la mise en œuvre de la garantie légale de
          conformité encourt une amende civile d&apos;un montant maximal de 300 000 euros, qui peut être porté
          jusqu&apos;à 10 % du chiffre d&apos;affaires moyen annuel (article L. 242-18-1 du code de la
          consommation).
        </p>
        <p>
          Le consommateur bénéficie également de la garantie légale des vices cachés en application des
          articles 1641 à 1649 du code civil, pendant une durée de deux ans à compter de la découverte du
          défaut. Cette garantie donne droit à une réduction de prix si le contenu numérique ou le service
          numérique est conservé, ou à un remboursement intégral contre renonciation au contenu numérique
          ou au service numérique.
        </p>
      </div>
      <p>
        Les réponses produites par les modèles d&apos;intelligence artificielle sont générées
        automatiquement et peuvent être inexactes : une réponse erronée isolée ne constitue pas, à elle
        seule, un défaut de conformité du Service, dont la caractéristique est de donner accès à ces
        modèles (voir les <a href="/legal/cgu">CGU</a>).
      </p>

      <h2>12. Évolution du Service</h2>
      <p>
        Les modèles proposés dépendent de fournisseurs tiers et peuvent évoluer. Le vendeur peut
        apporter au Service des modifications qui ne sont pas nécessaires au maintien de sa conformité
        pour les raisons suivantes : sortie d&apos;une nouvelle version d&apos;un modèle, retrait d&apos;un modèle
        ou d&apos;une fonction par son fournisseur, sécurité, obligation légale, ou amélioration du Service.
        Ces modifications sont effectuées sans coût supplémentaire pour vous ; vous en êtes informé de
        manière claire, raisonnablement à l&apos;avance et sur un support durable, avec leur date.
      </p>
      <p>
        Si une modification a une incidence négative, qui n&apos;est pas mineure, sur votre accès au Service
        ou sur votre utilisation — par exemple le retrait de l&apos;ensemble des modèles d&apos;un fournisseur
        inclus dans votre offre sans équivalent — vous pouvez résoudre le contrat sans frais dans un délai
        de trente jours, la part du prix correspondant à la période non fournie vous étant remboursée
        (article L. 224-25-26 du code de la consommation).
      </p>

      <h2>13. Responsabilité</h2>
      <p>
        Le vendeur est responsable de la bonne exécution du contrat dans les conditions du droit commun.
        Il n&apos;est pas responsable d&apos;un manquement imputable à votre fait, au fait imprévisible et
        insurmontable d&apos;un tiers au contrat, ou à un cas de force majeure. Vis-à-vis d&apos;un consommateur,
        aucune clause des présentes ne limite le droit à réparation du préjudice subi du fait d&apos;un
        manquement du vendeur.
      </p>
      <p>
        <strong>Clients professionnels</strong> : la responsabilité du vendeur est limitée aux dommages
        directs prouvés et plafonnée au montant payé au titre du Service au cours des douze mois
        précédant le fait générateur, sauf faute lourde ou dolosive et dommages corporels.
      </p>

      <h2>14. Données personnelles</h2>
      <p>
        Les données nécessaires à la commande, à la facturation et au Service sont traitées conformément
        à la <a href="/legal/confidentialite">politique de confidentialité</a>.
      </p>

      <h2>15. Service client et réclamations</h2>
      <p>
        Pour toute question ou réclamation : <Fill value={SELLER.email} what="adresse e-mail du service client" />{" "}
        ou par courrier à <Fill value={SELLER.address} what="adresse postale" />. Nous répondons dans un
        délai raisonnable, et au plus tard sous trente jours.
      </p>

      <h2>16. Médiation de la consommation</h2>
      <p>
        Conformément aux articles L. 612-1 et suivants du code de la consommation, si une réclamation
        écrite adressée au service client n&apos;a pas abouti, vous pouvez recourir{" "}
        <strong>gratuitement</strong> au médiateur de la consommation dont relève le vendeur :
      </p>
      <ul>
        <li>
          Médiateur : <Fill value={MEDIATOR.name} what="nom du médiateur de la consommation (liste CECMC)" />
        </li>
        <li>
          Adresse : <Fill value={MEDIATOR.address} what="adresse postale du médiateur" />
        </li>
        <li>
          Site internet : <Fill value={MEDIATOR.website} what="adresse du site internet du médiateur" />
        </li>
      </ul>
      <p>
        Le médiateur doit être saisi dans un délai d&apos;un an à compter de votre réclamation écrite auprès
        du vendeur. La plateforme européenne de règlement en ligne des litiges (« RLL/ODR ») a été fermée
        le 20 juillet 2025 (règlement (UE) 2024/3228) ; pour un litige transfrontalier dans l&apos;Union
        européenne, vous pouvez vous adresser au Centre européen des consommateurs France
        (<a href="https://www.europe-consommateurs.eu" rel="noopener noreferrer">europe-consommateurs.eu</a>).
      </p>

      <h2>17. Droit applicable et juridiction</h2>
      <p>
        Les CGV sont soumises au droit français. Si vous résidez dans un autre État membre de l&apos;Union
        européenne, vous conservez la protection des dispositions impératives du droit de votre pays de
        résidence. En cas de litige, vous pouvez saisir, à votre choix, la juridiction du lieu où vous
        demeuriez au moment de la conclusion du contrat ou de la survenance du fait dommageable, ou toute
        autre juridiction compétente selon le droit commun (article R. 631-3 du code de la consommation).
        Entre professionnels, compétence est attribuée aux tribunaux du ressort du siège du vendeur.
      </p>

      <h2>18. Articles reproduits (article L. 215-4 du code de la consommation)</h2>
      <p>
        <strong>Article L. 215-1.</strong> Pour les contrats de prestations de services conclus pour une
        durée déterminée avec une clause de reconduction tacite, le professionnel prestataire de services
        informe le consommateur par écrit, par lettre nominative ou courrier électronique dédiés, au plus
        tôt trois mois et au plus tard un mois avant le terme de la période autorisant le rejet de la
        reconduction, de la possibilité de ne pas reconduire le contrat qu&apos;il a conclu avec une clause de
        reconduction tacite. Cette information, délivrée dans des termes clairs et compréhensibles,
        mentionne, dans un encadré apparent, la date limite de non-reconduction.
      </p>
      <p>
        Lorsque cette information ne lui a pas été adressée conformément aux dispositions du premier
        alinéa, le consommateur peut mettre gratuitement un terme au contrat, à tout moment à compter de
        la date de reconduction.
      </p>
      <p>
        Les avances effectuées après la dernière date de reconduction ou, s&apos;agissant des contrats à durée
        indéterminée, après la date de transformation du contrat initial à durée déterminée, sont dans ce
        cas remboursées dans un délai de trente jours à compter de la date de résiliation, déduction faite
        des sommes correspondant, jusqu&apos;à celle-ci, à l&apos;exécution du contrat.
      </p>
      <p>
        Les dispositions du présent article s&apos;appliquent sans préjudice de celles qui soumettent
        légalement certains contrats à des règles particulières en ce qui concerne l&apos;information du
        consommateur.
      </p>
      <p>
        Par exception au premier alinéa du présent article, pour les contrats de fourniture de service de
        télévision au sens de l&apos;article 2 de la loi n° 86-1067 du 30 septembre 1986 relative à la liberté
        de communication et pour les contrats de fourniture de services de médias audiovisuels à la
        demande, le consommateur peut mettre gratuitement un terme au contrat, à tout moment à compter de
        la première reconduction, dès lors qu&apos;il change de domicile ou que son foyer fiscal évolue.
      </p>
      <p>
        <strong>Article L. 215-1-1.</strong> Lorsqu&apos;un contrat a été conclu par voie électronique ou a
        été conclu par un autre moyen et que le professionnel, au jour de la résiliation par le
        consommateur, offre au consommateur la possibilité de conclure des contrats par voie électronique,
        la résiliation est rendue possible selon cette modalité.
      </p>
      <p>
        A cet effet, le professionnel met à la disposition du consommateur une fonctionnalité gratuite
        permettant d&apos;accomplir, par voie électronique, la notification et les démarches nécessaires à la
        résiliation du contrat. Lorsque le consommateur notifie la résiliation du contrat, le professionnel
        lui confirme la réception de la notification et l&apos;informe, sur un support durable et dans des
        délais raisonnables, de la date à laquelle le contrat prend fin et des effets de la résiliation.
      </p>
      <p>
        Un décret fixe notamment les modalités techniques de nature à garantir une identification du
        consommateur et un accès facile, direct et permanent à la fonctionnalité mentionnée au deuxième
        alinéa, telles que ses modalités de présentation et d&apos;utilisation. Il détermine les informations
        devant être fournies par le consommateur.
      </p>
      <p>
        <strong>Article L. 215-2.</strong> Les dispositions du présent chapitre, à l&apos;exception de
        l&apos;article L. 215-1-1, ne sont pas applicables aux exploitants des services d&apos;eau potable et
        d&apos;assainissement.
      </p>
      <p>
        <strong>Article L. 215-3.</strong> Les dispositions du présent chapitre sont également applicables
        aux contrats conclus entre des professionnels et des non-professionnels.
      </p>
      <p>
        <strong>Article L. 241-3.</strong> Lorsque le professionnel n&apos;a pas procédé au remboursement
        dans les conditions prévues à l&apos;article L. 215-1, les sommes dues sont productives d&apos;intérêts au
        taux légal.
      </p>

      <h2>Annexe — Formulaire de rétractation</h2>
      <p className="text-muted-foreground">
        (Veuillez compléter et renvoyer le présent formulaire uniquement si vous souhaitez vous rétracter
        du contrat.)
      </p>
      <div className="mt-4 rounded-lg border border-border p-5 [&>p:first-child]:mt-0">
        <p>
          À l&apos;attention de <Fill value={SELLER.name} what="raison sociale" />,{" "}
          <Fill value={SELLER.address} what="adresse postale" />, adresse électronique :{" "}
          <Fill value={SELLER.email} what="adresse e-mail du service client" /> :
        </p>
        <p>
          Je/nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat
          portant sur la prestation de services ci-dessous :
        </p>
        <p>Commandé le : ……………………</p>
        <p>Nom du (des) consommateur(s) : ……………………</p>
        <p>Adresse du (des) consommateur(s) : ……………………</p>
        <p>Adresse e-mail du compte {PRODUCT_NAME} : ……………………</p>
        <p>Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) : ……………………</p>
        <p>Date : ……………………</p>
        <p className="text-muted-foreground">(*) Rayez la mention inutile.</p>
      </div>
    </>
  );
}
