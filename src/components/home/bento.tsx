import { BookOpen, EyeOff, MessageSquareText, Plug, Sparkles, UserPen } from "@/components/ui/icons";
import { InView } from "./in-view";

/**
 * Everything around the work, in five cells of different weight: memory is the
 * wide one because it changes every answer; voice is the dark one because it
 * is the one you hear; Library carries the material photograph.
 */

const WAVE = [14, 26, 40, 58, 72, 52, 34, 62, 84, 66, 44, 30, 50, 70, 46, 28, 18, 36, 24, 12];
/**
 * Connectors Alevr ships (src/lib/connectors*), each drawn with the company's
 * current mark on one shared tile. Single-colour marks (GitHub, Apple) take the
 * ink colour so they read in both themes; the rest keep their brand colours.
 * Apple's three connectors share the Apple mark.
 */
const APPS: { id: string; name: string; mono?: boolean }[] = [
  { id: "google-drive", name: "Google Drive" },
  { id: "microsoft", name: "Microsoft 365" },
  { id: "notion", name: "Notion" },
  { id: "github", name: "GitHub", mono: true },
  { id: "figma", name: "Figma" },
  { id: "apple", name: "Apple Calendar, Mail and Music", mono: true },
];

export function Bento() {
  return (
    <section className="alv-bento-section" aria-labelledby="alv-bento-title">
      <div className="alv-col">
        <h2 id="alv-bento-title" className="alv-h2" style={{ maxWidth: "11em" }}>Everything around the work.</h2>
        <div className="alv-bento">
          <article className="alv-cell alv-cell-a">
            <h3>It remembers what matters.</h3>
            <p className="alv-body">Your role, your projects, how you like answers. Memory keeps the context you choose, and you can read, edit or turn off every line.</p>
            <div className="alv-cell-art alv-memory">
              <div className="alv-memory-row"><UserPen aria-hidden />Leads product design at a 40-person startup<small>From a chat</small></div>
              <div className="alv-memory-row"><MessageSquareText aria-hidden />Prefers short answers with the sources listed<small>Instructions</small></div>
              <div className="alv-memory-row"><BookOpen aria-hidden />Field Notes 2.0 launches on the 14th<small>Project</small></div>
            </div>
          </article>
          <article className="alv-cell alv-cell-b alv-cell-ink">
            <h3>Talk it through.</h3>
            <p className="alv-body">Speak and hear the answer in real time, or dictate in your own language.</p>
            <InView className="alv-cell-art alv-wave" amount={0.5} repeat>
              {WAVE.map((h, i) => <i key={i} style={{ ["--h" as string]: h, ["--i" as string]: i }} />)}
            </InView>
          </article>
          <article className="alv-cell alv-cell-c alv-cell-plate">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand plate, sized by its cell */}
            <img src="/brand/public-aperture.webp" alt="" loading="lazy" decoding="async" />
            <h3>One place for what you know.</h3>
            <p className="alv-body">Library and Projects keep your files, chats and finished work together.</p>
          </article>
          <article className="alv-cell alv-cell-d">
            <h3>Connect your tools.</h3>
            <p className="alv-body">Google Drive, Microsoft 365, GitHub, Notion, Figma and your Apple apps. Add any MCP server, and skills that teach Alevr how you work.</p>
            <ul className="alv-cell-art alv-apps" aria-label="Apps you can connect">
              {APPS.map(({ id, name, mono }) => (
                <li key={id} className="alv-app" title={name}>
                  {mono
                    ? <span className="alv-app-mono" role="img" aria-label={name} style={{ maskImage: `url(/brand/apps/${id}.svg)`, WebkitMaskImage: `url(/brand/apps/${id}.svg)` }} />
                    // eslint-disable-next-line @next/next/no-img-element -- small static brand marks
                    : <img src={`/brand/apps/${id}.svg`} alt={name} width={24} height={24} loading="lazy" />}
                </li>
              ))}
              <li className="alv-app alv-app-more" title="Any MCP server"><Plug aria-hidden /><span className="sr-only">Any MCP server</span></li>
              <li className="alv-app alv-app-more" title="Skills"><Sparkles aria-hidden /><span className="sr-only">Skills</span></li>
            </ul>
          </article>
          <article className="alv-cell alv-cell-e">
            <h3>Incognito when you need it.</h3>
            <p className="alv-body">Turn on incognito and nothing from the conversation is saved.</p>
            <div className="alv-cell-art"><span className="alv-private"><EyeOff aria-hidden />Incognito is on. Nothing is saved.</span></div>
          </article>
        </div>
      </div>
    </section>
  );
}
