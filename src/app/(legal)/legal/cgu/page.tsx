import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { DSA_CONTACT, MEDIATOR, SELLER, SERVICE_HOST } from "@/lib/legal/seller";
import { Fill } from "@/components/legal/fill";

/**
 * Conditions générales d'utilisation (CGU) — how the Service may be used.
 *
 * Everything about the sale (offers, TTC prices, usage limits, payment,
 * renewal, cancellation, withdrawal, legal guarantees, mediation) lives in
 * the CGV at /legal/cgv, whose prices are computed from PLANS. This page used
 * to carry its own HT price table, which drifted from the plans and
 * contradicted the TTC display; it now points at the CGV instead. Owner-only
 * facts render as "[À COMPLÉTER : …]" from src/lib/legal/seller.ts.
 */

// Legal pages have no per-user content; force-static keeps them SSG even
// though the root layout reads the session cookie (empty at build time).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Conditions générales d'utilisation (CGU)",
  description:
    `Conditions générales d'utilisation de ${PRODUCT_NAME} (${SERVICE_HOST}) : description du service, compte, usage acceptable, contenus générés par l'IA, signalement des contenus publiés, disponibilité, responsabilité et droit applicable.`,
};

export default function CguPage() {
  return (
    <>
      <p className="font-mono text-label text-muted-foreground">{`${PRODUCT_NAME} · Conditions`}</p>
      <h1 className="mt-3">Conditions générales d&apos;utilisation</h1>
      <p className="text-muted-foreground">Dernière mise à jour : 4 octobre 2026.</p>

      <h2>1. Objet</h2>
      <p>
        {`Les présentes conditions générales d'utilisation (« CGU ») régissent l'accès et l'utilisation du service ${PRODUCT_NAME} (le « Service »), accessible à l'adresse `}<strong>{SERVICE_HOST}</strong> et
        depuis ses applications, et édité par <Fill value={SELLER.name} what="raison sociale de l'éditeur" /> (voir les{" "}
        <a href="/legal/mentions-legales">mentions légales</a>). La création d&apos;un compte emporte
        acceptation des présentes. Les abonnements et achats sont en outre régis par les{" "}
        <a href="/legal/cgv">conditions générales de vente</a> (« CGV »), qui prévalent sur les CGU pour
        tout ce qui concerne la vente.
      </p>

      <h2>2. Description du Service</h2>
      <p>
        {`${PRODUCT_NAME} est un assistant conversationnel d'intelligence artificielle donnant accès, depuis une interface unique, à plusieurs modèles de langage de différents laboratoires (génération de texte, de code, d'images et autres fonctionnalités associées : projets, mémoire, artefacts, mode vocal). Les modèles disponibles peuvent évoluer à tout moment en fonction des offres des fournisseurs tiers.`}
      </p>

      <h2>3. Compte</h2>
      <p>
        L&apos;utilisation du Service nécessite un compte personnel. Vous êtes responsable de la
        confidentialité de vos identifiants et de l&apos;activité réalisée depuis votre compte. Le Service
        est réservé aux personnes d&apos;au moins 15 ans (ou l&apos;âge de consentement numérique applicable) ;
        les mineurs doivent disposer de l&apos;autorisation d&apos;un titulaire de l&apos;autorité parentale.
      </p>

      <h2>4. Offres, prix, paiement et résiliation</h2>
      <p>
        Le Service est accessible gratuitement dans la limite de l&apos;offre Free, et selon des offres
        payantes. Les offres, leurs caractéristiques, leurs <strong>prix toutes taxes comprises</strong>,
        les limites d&apos;utilisation, le paiement, le renouvellement, la résiliation, le droit de
        rétractation et les garanties légales sont décrits dans les{" "}
        <a href="/legal/cgv">conditions générales de vente</a>. La consommation en cours et les limites
        applicables à votre compte sont affichées dans Réglages → Plan &amp; usage.
      </p>

      <h2>5. Suppression du compte</h2>
      <p>
        Vous pouvez supprimer votre compte à tout moment (Réglages → Compte) ; la suppression entraîne
        l&apos;effacement des données dans les conditions de la{" "}
        <a href="/legal/confidentialite">politique de confidentialité</a>. Supprimer le compte ne
        résilie pas un abonnement souscrit via l&apos;App Store, qui se résilie auprès d&apos;Apple.
      </p>

      <h2>6. Suspension par l&apos;éditeur</h2>
      <p>
        L&apos;éditeur peut suspendre ou résilier un compte en cas de violation grave ou répétée des
        présentes (notamment de l&apos;article 7), après notification motivée lorsque cela est possible,
        dans les conditions prévues aux CGV.
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
      <p>
        Les images, vidéos et sons générés par le Service sont signalés comme générés par
        l&apos;intelligence artificielle, par une mention visible et, lorsque le format le permet, par un
        marquage lisible par machine inscrit dans le fichier (règlement (UE) 2024/1689, article 50). Vous
        vous engagez à ne pas retirer ce marquage et, si vous diffusez un contenu généré qui représente de
        manière réaliste des personnes, des lieux ou des événements (« hypertrucage »), à indiquer
        clairement qu&apos;il a été généré ou manipulé par l&apos;IA.
      </p>

      <h2>9. Contenus publiés et signalement</h2>
      <p>
        Lorsque vous partagez ou publiez un contenu par un lien public, vous en restez responsable et
        garantissez qu&apos;il respecte la loi et les droits des tiers. Toute personne peut signaler un
        contenu publié qu&apos;elle estime illicite au moyen du lien « Report » présent au pied de chaque
        page publique, ou en écrivant au point de contact ci-dessous, en indiquant l&apos;adresse du
        contenu, les raisons du signalement, ses nom et adresse e-mail (sauf pour certaines infractions
        graves) et une déclaration de bonne foi (règlement (UE) 2022/2065 sur les services numériques,
        article 16). Les signalements sont examinés par une personne ; si le contenu est retiré, son
        auteur reçoit un exposé des motifs et peut contester la décision en répondant au point de contact.
        Les abus répétés peuvent entraîner la suspension du compte.
      </p>
      <p>
        Point de contact unique pour les utilisateurs et les autorités (articles 11 et 12 du même
        règlement) : <Fill value={DSA_CONTACT ?? SELLER.email} what="adresse e-mail du point de contact (signalements et autorités)" />,
        en français ou en anglais.
      </p>

      <h2>10. Disponibilité</h2>
      <p>
        Le Service est accessible 24 h/24 dans la mesure du raisonnable. Des interruptions pour
        maintenance, mise à jour ou indisponibilité des fournisseurs tiers (hébergeur, Stripe, API des
        modèles) peuvent survenir ; l&apos;éditeur s&apos;efforce de les limiter et de les annoncer à
        l&apos;avance lorsqu&apos;elles sont prévues. Ces stipulations ne privent pas le consommateur de la
        garantie légale de conformité, dont la continuité du Service est un critère (article 11 des{" "}
        <a href="/legal/cgv">CGV</a>).
      </p>

      <h2>11. Responsabilité</h2>
      <p>
        Les réponses générées par les modèles d&apos;IA sont produites automatiquement et{" "}
        <strong>peuvent être inexactes, incomplètes ou inappropriées</strong> ; elles ne constituent
        ni un conseil professionnel (juridique, médical, financier) ni une garantie de résultat. Il
        vous appartient de vérifier les sorties avant toute utilisation. La responsabilité de
        l&apos;éditeur envers un consommateur est régie par les{" "}
        <a href="/legal/cgv">CGV</a> et le droit commun ; aucune stipulation des présentes ne limite le
        droit d&apos;un consommateur à réparation du préjudice subi du fait d&apos;un manquement de
        l&apos;éditeur. Envers un client professionnel, elle est limitée dans les conditions des CGV.
      </p>

      <h2>12. Modification des CGU</h2>
      <p>
        L&apos;éditeur peut faire évoluer les présentes conditions pour tenir compte de l&apos;évolution du
        Service ou de la loi. Les modifications substantielles sont notifiées dans le Service ou par
        e-mail au moins 15 jours avant leur entrée en vigueur ; si vous les refusez, vous pouvez supprimer
        votre compte et, le cas échéant, résilier votre abonnement sans frais avant cette date. Les
        modifications des prix et des caractéristiques des offres suivent les règles des{" "}
        <a href="/legal/cgv">CGV</a>.
      </p>

      <h2>13. Droit applicable et litiges</h2>
      <p>
        Les présentes sont soumises au <strong>droit français</strong>, sans priver le consommateur
        résidant dans un autre État membre de l&apos;Union européenne des dispositions impératives de son
        pays. En cas de litige, une solution amiable sera recherchée en priorité. Le consommateur peut
        recourir gratuitement au médiateur de la consommation{" "}
        <Fill value={MEDIATOR.name} what="nom du médiateur de la consommation" /> (
        <Fill value={MEDIATOR.website} what="site internet du médiateur" />), dans les conditions
        prévues à l&apos;article 16 des <a href="/legal/cgv">CGV</a>. La plateforme européenne de
        règlement en ligne des litiges a été fermée le 20 juillet 2025. À défaut d&apos;accord, les
        tribunaux sont compétents dans les conditions prévues aux CGV.
      </p>
    </>
  );
}
