import { LAB_FACES, LAB_FONT_CLASSES } from "./lab-fonts";

/* The type lab: every candidate at the real sizes, same words, so the face is chosen by eye. */
export function TypeLab({ only }: { only?: string }) {
  const faces = only ? LAB_FACES.filter((f) => only.split(",").includes(f.id)) : LAB_FACES;
  return (
    <div className={`cv-lab ${LAB_FONT_CLASSES}`}>
      {faces.map((f) => (
        <section key={f.id} className="cv-lab__row">
          <p className="cv-lab__name">{f.name}</p>
          <div className="cv-lab__cols">
            <div>
              <p className="cv-lab__greet" style={{ fontFamily: f.display }}>
                What’s next, Liam?
              </p>
              <p className="cv-lab__body" style={{ fontFamily: f.text }}>
                Stripe shows <span className="cv-lab__m">€412,000</span> of the €438,000 the forecast expects from renewals. Three
                accounts make up the gap: Halvorsen moved to monthly billing in August.
              </p>
              <p className="cv-lab__intl" style={{ fontFamily: f.text }}>
                Привет, Лиам. Сверь прогноз с Stripe · Xin chào, Liam. Đối chiếu dự báo quý 3
              </p>
            </div>
            <div className="cv-lab__ui" style={{ fontFamily: f.text }}>
              <p>New chat</p>
              <p>Search</p>
              <p>Projects</p>
              <p className="cv-lab__muted">Recent</p>
              <p>Q3 forecast against Stripe revenue</p>
              <p className="cv-lab__nums">€96,000 · €72,400 · €23,600 · 1,118 · 4:30</p>
              <p className="cv-lab__h">Renewal risk this quarter</p>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
