/**
 * The database a SQL block runs against in the browser (sql.js, SQLite):
 * a subset of Oracle's HR sample schema, the one most SQL courses use.
 *
 * Real rows from the Oracle sample (names, salaries, managers, hire dates),
 * cut to 29 of the 107 employees so the seed stays small. Every department
 * keeps its manager, IT (60) keeps all five of its people, and Grant (178)
 * keeps the missing department that makes NULL lessons work. Oracle-only
 * syntax (CONNECT BY, ROWNUM, sequences, PL/SQL) does not run in SQLite; the
 * console says so when a statement fails.
 */

const departments: [number, string, number | null, number][] = [
  [10, "Administration", 200, 1700],
  [20, "Marketing", 201, 1800],
  [30, "Purchasing", 114, 1700],
  [40, "Human Resources", 203, 2400],
  [50, "Shipping", 121, 1500],
  [60, "IT", 103, 1400],
  [70, "Public Relations", 204, 2700],
  [80, "Sales", 145, 2500],
  [90, "Executive", 100, 1700],
  [100, "Finance", 108, 1700],
  [110, "Accounting", 205, 1700],
];

const jobs: [string, string, number, number][] = [
  ["AD_PRES", "President", 20080, 40000],
  ["AD_VP", "Administration Vice President", 15000, 30000],
  ["AD_ASST", "Administration Assistant", 3000, 6000],
  ["FI_MGR", "Finance Manager", 8200, 16000],
  ["FI_ACCOUNT", "Accountant", 4200, 9000],
  ["AC_MGR", "Accounting Manager", 8200, 16000],
  ["AC_ACCOUNT", "Public Accountant", 4200, 9000],
  ["SA_MAN", "Sales Manager", 10000, 20080],
  ["SA_REP", "Sales Representative", 6000, 12008],
  ["PU_MAN", "Purchasing Manager", 8000, 15000],
  ["PU_CLERK", "Purchasing Clerk", 2500, 5500],
  ["ST_MAN", "Stock Manager", 5500, 8500],
  ["IT_PROG", "Programmer", 4000, 10000],
  ["MK_MAN", "Marketing Manager", 9000, 15000],
  ["MK_REP", "Marketing Representative", 4000, 9000],
  ["HR_REP", "Human Resources Representative", 4000, 9000],
  ["PR_REP", "Public Relations Representative", 4500, 10500],
];

// employee_id, first_name, last_name, email, hire_date, job_id, salary, commission_pct, manager_id, department_id
const employees: [number, string, string, string, string, string, number, number | null, number | null, number | null][] = [
  [100, "Steven", "King", "SKING", "2003-06-17", "AD_PRES", 24000, null, null, 90],
  [101, "Neena", "Kochhar", "NKOCHHAR", "2005-09-21", "AD_VP", 17000, null, 100, 90],
  [102, "Lex", "De Haan", "LDEHAAN", "2001-01-13", "AD_VP", 17000, null, 100, 90],
  [103, "Alexander", "Hunold", "AHUNOLD", "2006-01-03", "IT_PROG", 9000, null, 102, 60],
  [104, "Bruce", "Ernst", "BERNST", "2007-05-21", "IT_PROG", 6000, null, 103, 60],
  [105, "David", "Austin", "DAUSTIN", "2005-06-25", "IT_PROG", 4800, null, 103, 60],
  [106, "Valli", "Pataballa", "VPATABAL", "2006-02-05", "IT_PROG", 4800, null, 103, 60],
  [107, "Diana", "Lorentz", "DLORENTZ", "2007-02-07", "IT_PROG", 4200, null, 103, 60],
  [108, "Nancy", "Greenberg", "NGREENBE", "2002-08-17", "FI_MGR", 12008, null, 101, 100],
  [109, "Daniel", "Faviet", "DFAVIET", "2002-08-16", "FI_ACCOUNT", 9000, null, 108, 100],
  [110, "John", "Chen", "JCHEN", "2005-09-28", "FI_ACCOUNT", 8200, null, 108, 100],
  [111, "Ismael", "Sciarra", "ISCIARRA", "2005-09-30", "FI_ACCOUNT", 7700, null, 108, 100],
  [112, "Jose Manuel", "Urman", "JMURMAN", "2006-03-07", "FI_ACCOUNT", 7800, null, 108, 100],
  [113, "Luis", "Popp", "LPOPP", "2007-12-07", "FI_ACCOUNT", 6900, null, 108, 100],
  [114, "Den", "Raphaely", "DRAPHEAL", "2002-12-07", "PU_MAN", 11000, null, 100, 30],
  [115, "Alexander", "Khoo", "AKHOO", "2003-05-18", "PU_CLERK", 3100, null, 114, 30],
  [120, "Matthew", "Weiss", "MWEISS", "2004-07-18", "ST_MAN", 8000, null, 100, 50],
  [121, "Adam", "Fripp", "AFRIPP", "2005-04-10", "ST_MAN", 8200, null, 100, 50],
  [145, "John", "Russell", "JRUSSEL", "2004-10-01", "SA_MAN", 14000, 0.4, 100, 80],
  [146, "Karen", "Partners", "KPARTNER", "2005-01-05", "SA_MAN", 13500, 0.3, 100, 80],
  [174, "Ellen", "Abel", "EABEL", "2004-05-11", "SA_REP", 11000, 0.3, 145, 80],
  [178, "Kimberely", "Grant", "KGRANT", "2007-05-24", "SA_REP", 7000, 0.15, 145, null],
  [200, "Jennifer", "Whalen", "JWHALEN", "2003-09-17", "AD_ASST", 4400, null, 101, 10],
  [201, "Michael", "Hartstein", "MHARTSTE", "2004-02-17", "MK_MAN", 13000, null, 100, 20],
  [202, "Pat", "Fay", "PFAY", "2005-08-17", "MK_REP", 6000, null, 201, 20],
  [203, "Susan", "Mavris", "SMAVRIS", "2002-06-07", "HR_REP", 6500, null, 101, 40],
  [204, "Hermann", "Baer", "HBAER", "2002-06-07", "PR_REP", 10000, null, 101, 70],
  [205, "Shelley", "Higgins", "SHIGGINS", "2002-06-07", "AC_MGR", 12008, null, 101, 110],
  [206, "William", "Gietz", "WGIETZ", "2002-06-07", "AC_ACCOUNT", 8300, null, 205, 110],
];

const value = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const rows = (list: (string | number | null)[][]) => list.map((r) => `(${r.map(value).join(", ")})`).join(",\n");

export const HR_SAMPLE_SQL = `
CREATE TABLE regions (region_id INTEGER PRIMARY KEY, region_name TEXT);
INSERT INTO regions VALUES (1, 'Europe'), (2, 'Americas'), (3, 'Asia'), (4, 'Middle East and Africa');
CREATE TABLE jobs (job_id TEXT PRIMARY KEY, job_title TEXT NOT NULL, min_salary INTEGER, max_salary INTEGER);
INSERT INTO jobs VALUES
${rows(jobs)};
CREATE TABLE departments (department_id INTEGER PRIMARY KEY, department_name TEXT NOT NULL, manager_id INTEGER, location_id INTEGER);
INSERT INTO departments VALUES
${rows(departments)};
CREATE TABLE employees (
  employee_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  hire_date TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(job_id), salary NUMERIC, commission_pct NUMERIC,
  manager_id INTEGER REFERENCES employees(employee_id), department_id INTEGER REFERENCES departments(department_id)
);
INSERT INTO employees VALUES
${rows(employees)};
CREATE TABLE dual (dummy TEXT);
INSERT INTO dual VALUES ('X');
`;

/** What the console prints before the first result, so nobody mistakes the sample for their own database. */
export const HR_SAMPLE_NOTE = "SQLite in your browser, on a sample of Oracle's HR schema (29 of 107 employees). Oracle-only syntax may not run.";
