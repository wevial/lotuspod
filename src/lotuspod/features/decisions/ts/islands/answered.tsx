import { render } from "preact";
import type { Answer, Page } from "../../../comments/ts/index";
import { all } from "./checklist";
import { holds, kept, label, words } from "./words";

// The "Answered" table that ends the page's body: one row per answered
// question, newest first, drawn from the store's current answers, read
// from the answers route or saved since. forms gives the form asking a
// question, if the page asks it; change opens it again.
export function answeredTable(page: Page, formOf: (question: string) => HTMLFormElement | null,
  change: (form: HTMLFormElement) => void) {
  let answered: HTMLElement | null = null;

  // A row of the table. A question the page asks as it was answered takes
  // its number, question and label from its card, and has "change" unless
  // it is dismissed; any other takes the words it was answered in, or else
  // its id and the choice. A checklist has no number.
  function Row({ answer }: { answer: Answer }) {
    const question = String(answer.question);
    const form = formOf(question);
    const asks = Boolean(form) && holds(form!, answer);
    const asked = answer.asked || {};
    const id = Array.isArray(answer.checked) ? "" : question.replace(/^decision-/, "");
    const number = asks ? words(form!, ".artifact-decision-number") || id : id;
    const text = asks ? words(form!, ".artifact-decision-text") : asked.text ? String(asked.text) : question;
    const chosen = asks ? label(form!, answer) : kept(answer);
    return (
      <tr data-question={question}>
        <td class="artifact-answered-number">{number}</td>
        <td class="artifact-answered-when">{page.when(answer.createdAt)}</td>
        <td class="artifact-answered-question">{text}</td>
        <td class="artifact-answered-answer">
          <p class="artifact-answered-choice">
            <strong>{chosen}</strong>
            {asks && !answer.dismissed && <>{" · "}<button type="button" class="artifact-decision-change"
              onClick={() => change(form!)}>change</button></>}
          </p>
          {answer.source && <p class="artifact-answered-source">{"Answered elsewhere: " + answer.source}</p>}
          {answer.note && <p class="artifact-answered-note">{answer.note}</p>}
        </td>
        <td class="artifact-answered-by">{page.reader(answer)}</td>
      </tr>
    );
  }

  // The table right after the body's last section, else at its end.
  function place(body: Element, last: Element | undefined): void {
    if (last) {
      last.after(answered!);
    } else {
      body.appendChild(answered!);
    }
  }

  // Draw the table from the current answers, after the body's last
  // section, so folding a section never hides it; none while nothing is
  // answered. It folds under its heading, "Answered (N)", as a section
  // does, and is kept folded as one is.
  return function table(rows: readonly Answer[]): void {
    if (!rows.length) {
      if (answered) {
        render(null, answered.querySelector("tbody")!);
        answered.remove();
        answered = null;
      }
      return;
    }
    const body = document.querySelector("section.artifact-body");
    if (!body) {
      return;
    }
    const last = all(":scope > .artifact-section-body", body).pop();
    if (!answered) {
      answered = page.element("div", "artifact-answered");
      // A heading of the section's level, though not one of the page's h2s.
      const heading = page.element("div", "artifact-answered-heading");
      heading.setAttribute("role", "heading");
      heading.setAttribute("aria-level", "2");
      heading.appendChild(page.element("span", "artifact-answered-title"));
      const wrapper = page.element("div", "artifact-answered-body");
      const grid = page.element("table", "");
      grid.setAttribute("aria-label", "Answered");
      const head = page.element("tr", "");
      for (const name of ["#", "When", "Question", "Answer", "By"]) {
        const th = page.element("th", "", name);
        th.scope = "col";
        head.appendChild(th);
      }
      grid.appendChild(page.element("thead", "")).appendChild(head);
      grid.appendChild(page.element("tbody", ""));
      wrapper.appendChild(grid);
      answered.append(heading, wrapper);
      place(body, last);
      page.foldSection(heading, wrapper, page.foldedAnswered);
    } else if (last ? last.nextElementSibling !== answered : answered.parentNode !== body) {
      // A swap added a section after it.
      place(body, last);
    }
    answered.querySelector(".artifact-answered-title")!.textContent = "Answered (" + rows.length + ")";
    render(<>{rows.map((answer) => <Row key={String(answer.question)} answer={answer} />)}</>,
      answered.querySelector("tbody")!);
  };
}
