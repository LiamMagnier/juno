import type { Metadata } from "next";

/**
 * Conditions générales d'utilisation et de vente (CGU/CGV) — static French
 * terms for Juno. The [bracketed] placeholders must be filled in by the site
 * owner before the service is offered commercially.
 */

// Legal pages have no per-user content; force-static keeps them SSG even
// though the root layout reads the session cookie (empty at build time).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Conditions générales (CGU / CGV)",
  description:
    "Conditions générales d'utilisation et de vente de Juno (chat.liams.dev) : description du service, plans et tarifs, paiement Stripe, résiliation, usage acceptable, disponibilité, responsabilité et droit applicable.",
};

export default function CguPage() {
  return (
    <>
      <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Juno · Conditions</p>
      <h1 className="mt-3">Conditions générales d&apos;utilisation et de vente</h1>
      <p className="text-muted-foreground">Dernière mise à jour : 5 juillet 2026.</p>

      <h2>1. Objet</h2>
      <p>
        Les présentes conditions générales (« CGU/CGV ») régissent l&apos;accès et l&apos;utilisation du
        service Juno (le « Service »), accessible à l&apos;adresse <strong>chat.liams.dev</strong> et
        édité par <strong>[Nom / raison sociale]</strong> (voir les{" "}
        <a href="/legal/mentions-legales">mentions légales</a>). La création d&apos;un compte ou la
        souscription d&apos;un abonnement emporte acceptation pleine et entière des présentes.
      </p>

      <h2>2. Description du Service</h2>
      <p>
        Juno est un assistant conversationnel d&apos;intelligence artificielle donnant accès, depuis une
        interface unique, à plusieurs modèles de langage de différents laboratoires (génération de
        texte, de code, d&apos;images et autres fonctionnalités associées : projets, mémoire, artefacts,
        mode vocal). Les modèles disponibles peuvent évoluer à tout moment en fonction des offres des
        fournisseurs tiers.
      </p>

      <h2>3. Compte</h2>
      <p>
        L&apos;utilisation du Service nécessite un compte personnel. Vous êtes responsable de la
        confidentialité de vos identifiants et de l&apos;activité réalisée depuis votre compte. Le Service
        est réservé aux personnes d&apos;au moins 15 ans (ou l&apos;âge de consentement numérique applicable) ;
        les mineurs doivent disposer de l&apos;autorisation d&apos;un titulaire de l&apos;autorité parentale.
      </p>

      <h2>4. Plans et tarifs</h2>
      <p>
        Le Service est proposé selon les plans suivants. Les prix sont exprimés <strong>hors taxes
        (HT)</strong>, par mois ; la TVA applicable est ajoutée au moment du paiement. Chaque plan
        inclut un budget mensuel de consommation des API des modèles ; au-delà, l&apos;accès aux modèles
        peut être suspendu jusqu&apos;au cycle suivant.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Prix (HT / mois)</th>
              <th scope="col">Budget API mensuel</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Pro</td>
              <td>20 €</td>
              <td>15 €</td>
            </tr>
            <tr>
              <td>Max x5</td>
              <td>100 €</td>
              <td>75 €</td>
            </tr>
            <tr>
              <td>Max x20</td>
              <td>200 €</td>
              <td>150 €</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Les caractéristiques détaillées de chaque plan (quotas de messages, taille des fichiers,
        fonctionnalités) sont présentées sur la page d&apos;abonnement du Service et peuvent évoluer ;
        toute modification tarifaire est notifiée au moins 30 jours avant son entrée en vigueur et ne
        s&apos;applique qu&apos;au cycle de facturation suivant.
      </p>

      <h2>5. Paiement et facturation</h2>
      <p>
        Les abonnements sont payables mensuellement, d&apos;avance, par carte bancaire via notre
        prestataire de paiement <strong>Stripe</strong>. L&apos;abonnement est reconduit tacitement chaque
        mois jusqu&apos;à résiliation. En cas d&apos;échec de paiement, l&apos;accès aux fonctionnalités payantes
        peut être suspendu après notification.
      </p>
      <p>
        Conformément à l&apos;article L. 221-28 du code de la consommation, en demandant l&apos;accès immédiat
        au Service, le consommateur reconnaît que le droit de rétractation de 14 jours ne peut plus
        être exercé une fois le service pleinement exécuté, et qu&apos;en cas de rétractation avant
        complète exécution, un montant proportionnel au service déjà fourni reste dû.
      </p>

      <h2>6. Résiliation</h2>
      <p>
        Vous pouvez résilier votre abonnement à tout moment depuis les réglages du Service (gestion
        de l&apos;abonnement Stripe). La résiliation prend effet à la fin de la période de facturation en
        cours ; l&apos;accès aux fonctionnalités payantes est maintenu jusqu&apos;à cette date. La suppression
        du compte est possible à tout moment et entraîne l&apos;effacement des données dans les conditions
        de la <a href="/legal/confidentialite">politique de confidentialité</a>. L&apos;éditeur peut
        suspendre ou résilier un compte en cas de violation grave ou répétée des présentes, après
        notification lorsque cela est possible.
      </p>

      <h2>7. Usage acceptable</h2>
      <p>Vous vous engagez à ne pas utiliser le Service pour :</p>
      <ul>
        <li>des activités illégales, frauduleuses ou portant atteinte aux droits de tiers ;</li>
        <li>
          générer ou diffuser des contenus manifestement illicites (haine, harcèlement, exploitation
          de mineurs, désinformation malveillante) ;
        </li>
        <li>
          tenter de contourner les quotas, les budgets API, les mécanismes de sécurité ou d&apos;accéder
          aux données d&apos;autres utilisateurs ;
        </li>
        <li>
          revendre l&apos;accès au Service ou l&apos;exploiter de manière automatisée massive sans accord écrit
          préalable.
        </li>
      </ul>
      <p>
        L&apos;utilisation des modèles reste également soumise aux politiques d&apos;usage des laboratoires
        d&apos;IA concernés.
      </p>

      <h2>8. Contenus et propriété</h2>
      <p>
        Vous restez titulaire des contenus que vous soumettez au Service. Sous réserve des droits des
        tiers et du droit applicable, les sorties générées pour votre compte peuvent être librement
        utilisées par vous. Vous accordez à l&apos;éditeur la licence strictement nécessaire pour opérer le
        Service (hébergement, transmission aux API des modèles sélectionnés, affichage).
      </p>

      <h2>9. Disponibilité</h2>
      <p>
        Le Service est fourni « en l&apos;état » et accessible 24 h/24 dans la mesure du raisonnable,
        sans engagement de niveau de service. Des interruptions pour maintenance, mise à jour, ou
        indisponibilité des fournisseurs tiers (hébergeur, Stripe, API des modèles) peuvent survenir
        sans droit à indemnisation, hors remboursement prorata en cas d&apos;indisponibilité prolongée
        imputable à l&apos;éditeur.
      </p>

      <h2>10. Responsabilité</h2>
      <p>
        Les réponses générées par les modèles d&apos;IA sont produites automatiquement et{" "}
        <strong>peuvent être inexactes, incomplètes ou inappropriées</strong> ; elles ne constituent
        ni un conseil professionnel (juridique, médical, financier) ni une garantie de résultat. Il
        vous appartient de vérifier les sorties avant toute utilisation. La responsabilité de
        l&apos;éditeur, toutes causes confondues, est limitée aux dommages directs prouvés et ne peut
        excéder le montant des sommes versées au titre du Service au cours des 12 derniers mois. Rien
        dans les présentes n&apos;exclut la responsabilité qui ne peut être limitée en vertu de la loi.
      </p>

      <h2>11. Modification des CGU/CGV</h2>
      <p>
        L&apos;éditeur peut faire évoluer les présentes conditions. Les modifications substantielles sont
        notifiées dans le Service ou par e-mail au moins 15 jours avant leur entrée en vigueur ; la
        poursuite de l&apos;utilisation vaut acceptation.
      </p>

      <h2>12. Droit applicable et litiges</h2>
      <p>
        Les présentes sont soumises au <strong>droit français</strong>. En cas de litige, une solution
        amiable sera recherchée en priorité. Le consommateur peut recourir gratuitement à un médiateur
        de la consommation : <strong>[Médiateur de la consommation compétent — à désigner]</strong>,
        ou à la plateforme européenne de règlement en ligne des litiges. À défaut, les tribunaux
        français seront compétents dans les conditions du droit commun.
      </p>
    </>
  );
}
