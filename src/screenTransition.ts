// Smooth, animated swaps between the top-level app screens (home / texture
// workspace / shader workspace). The screens are block siblings inside the app
// shell, so we run the transition sequentially: the outgoing screen plays its
// exit animation, hides, and only then does the incoming screen reveal and play
// its enter animation. That keeps a single screen in layout flow at a time and
// avoids both screens stacking mid-transition.

const SCREEN_IDS = ["home-screen", "project-workspace", "shader-workspace"];

const EXIT_CLASS = "screen-exit";
const ENTER_CLASS = "screen-enter";

// Fallback timers in case animationend never fires (e.g. reduced-motion strips
// the animation, or the element is detached). Kept comfortably above the CSS
// durations so they only ever act as a safety net.
const EXIT_FALLBACK_MS = 220;
const ENTER_FALLBACK_MS = 340;

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const screenElements = () =>
  SCREEN_IDS.map((id) => document.getElementById(id)).filter(
    (element): element is HTMLElement => element !== null,
  );

const runOnce = (
  element: HTMLElement,
  fallbackMs: number,
  done: () => void,
): void => {
  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    element.removeEventListener("animationend", onAnimationEnd);
    window.clearTimeout(timer);
    done();
  };
  // Many child elements (mode panels, the category browser) run their own
  // animations that bubble an animationend up to the screen. Only react to the
  // screen's own enter/exit animation, otherwise we'd finish far too early.
  const onAnimationEnd = (event: AnimationEvent) => {
    if (event.target === element) {
      finish();
    }
  };
  const timer = window.setTimeout(finish, fallbackMs);
  element.addEventListener("animationend", onAnimationEnd);
};

const reveal = (incoming: HTMLElement): void => {
  incoming.classList.remove(EXIT_CLASS, ENTER_CLASS);
  incoming.removeAttribute("hidden");
  // Force a reflow so the enter animation always restarts from its first frame.
  void incoming.offsetWidth;
  incoming.classList.add(ENTER_CLASS);
  if (incoming.scrollTop !== 0) {
    incoming.scrollTop = 0;
  }
  runOnce(incoming, ENTER_FALLBACK_MS, () => incoming.classList.remove(ENTER_CLASS));
};

// Reveal `incomingId`, animating away whichever screen is currently visible.
export const showScreen = (incomingId: string): void => {
  const incoming = document.getElementById(incomingId);
  if (!incoming) {
    return;
  }

  const outgoing = screenElements().find(
    (element) => element !== incoming && !element.hasAttribute("hidden"),
  );

  // Any other lingering screens are hidden immediately so only the transition
  // pair is ever in flow.
  screenElements().forEach((element) => {
    if (element !== incoming && element !== outgoing) {
      element.classList.remove(EXIT_CLASS, ENTER_CLASS);
      element.setAttribute("hidden", "");
    }
  });

  if (!outgoing) {
    reveal(incoming);
    return;
  }

  if (prefersReducedMotion()) {
    outgoing.classList.remove(EXIT_CLASS, ENTER_CLASS);
    outgoing.setAttribute("hidden", "");
    incoming.classList.remove(EXIT_CLASS, ENTER_CLASS);
    incoming.removeAttribute("hidden");
    incoming.scrollTop = 0;
    return;
  }

  outgoing.classList.remove(ENTER_CLASS);
  void outgoing.offsetWidth;
  outgoing.classList.add(EXIT_CLASS);
  runOnce(outgoing, EXIT_FALLBACK_MS, () => {
    outgoing.classList.remove(EXIT_CLASS);
    outgoing.setAttribute("hidden", "");
    reveal(incoming);
  });
};
