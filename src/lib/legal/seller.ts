/**
 * WHO SELLS THE SERVICE — the one place the legal pages read it from.
 *
 * The CGV, the CGU, the mentions légales and the privacy policy all need the
 * same identity (Code de la consommation L111-1 and L221-5, LCEN art. 1-1 and
 * 6, CGI art. 242 nonies A for invoices, RGPD art. 13). Each field that is
 * still `null` renders on every page as a visible "[À COMPLÉTER : …]" marker,
 * so a missing fact can never be hidden by one page being filled in and
 * another forgotten. Fill a value here once and every page follows.
 *
 * NOTHING IN THIS FILE MAY BE GUESSED. Only the owner knows the company form,
 * the identifiers and the mediator; an invented SIREN or mediator would be a
 * false statement on a legal page. Leave a field null until the fact exists.
 *
 * What IS known and therefore filled: the host (Microsoft Azure, Sweden
 * Central region, per deploy/ and the production runbooks) and the database
 * provider (Supabase, AWS eu-west-1 Ireland, per docs/JUNO.md §20.2).
 */

export interface LegalParty {
  /** Raison sociale (or "Prénom Nom" for an entrepreneur individuel). */
  name: string | null;
  /** Forme juridique, e.g. "SASU", "EURL", "Entrepreneur individuel (micro-entreprise)". */
  legalForm: string | null;
  /** Share capital in euros, as written ("1 000 €"). Not applicable to an EI. */
  shareCapital: string | null;
  /** SIREN, 9 digits. */
  siren: string | null;
  /** "RCS Paris" or the registry the company is entered in (RNE for an EI). */
  registry: string | null;
  /** Full postal address of the registered office. */
  address: string | null;
  /** Intra-EU VAT number, "FR" + 2 key digits + SIREN. */
  vatNumber: string | null;
  /** Contact email shown to customers (support and legal requests). */
  email: string | null;
  /** A telephone number (LCEN 6-III and Code conso L221-5 ask for one). */
  phone: string | null;
  /** Directeur de la publication (LCEN): a natural person. */
  publicationDirector: string | null;
}

export interface Mediator {
  /** The mediator's name, as listed by the CECMC. */
  name: string | null;
  /** Postal address. */
  address: string | null;
  /** Website (R616-1 requires it to be shown). */
  website: string | null;
}

export interface HostInfo {
  name: string;
  /** null until checked against the provider's own legal notice or DPA. */
  address: string | null;
  phone: string | null;
  detail: string;
}

export const SELLER: LegalParty = {
  name: null,
  legalForm: null,
  shareCapital: null,
  siren: null,
  registry: null,
  address: null,
  vatNumber: null,
  email: null,
  phone: null,
  publicationDirector: null,
};

/** The consumer mediator the seller has signed up with (L612-1). */
export const MEDIATOR: Mediator = {
  name: null,
  address: null,
  website: null,
};

/**
 * Data-protection contact. A DPO is not mandatory for this processing at this
 * size (RGPD art. 37), so by default the privacy contact is the seller's email.
 */
export const PRIVACY_CONTACT: string | null = null;

/** Who answers DSA notices and authority requests (Reg. 2022/2065 art. 11-12). */
export const DSA_CONTACT: string | null = null;

/**
 * The application host. Production runs on a Microsoft Azure virtual machine
 * in the Sweden Central region. For customers in the EEA the Azure contracting
 * entity is Microsoft Ireland Operations Limited.
 */
export const HOST: HostInfo = {
  name: "Microsoft Ireland Operations Limited (Microsoft Azure)",
  address: "One Microsoft Place, South County Business Park, Leopardstown, Dublin 18, D18 P521, Irlande",
  phone: null,
  detail: "Machine virtuelle située dans la région Azure « Sweden Central » (Suède, Union européenne).",
};

/** The database host. */
export const DATABASE_HOST: HostInfo = {
  name: "Supabase, Inc.",
  // Take the contracting entity's address from the DPA you sign with Supabase.
  address: null,
  phone: null,
  detail:
    "Base de données PostgreSQL hébergée dans la région eu-west-1 (Irlande, Union européenne) sur l'infrastructure d'Amazon Web Services EMEA SARL.",
};

/** The public address of the service as the legal pages name it. */
export const SERVICE_HOST = "chat.liams.dev";
