export type TipKind = "prompt" | "fact" | "quote" | "nudge" | "recommendation";

export type MascotTip = {
  kind: TipKind;
  text: string;
  /** Attribution for quotes. */
  by?: string;
  /** Overrides the chip text (recommendations use their reason). */
  label?: string;
  /** Where this tip fits best. Tips with no context show anywhere. */
  context?: "upload" | "history";
};

export const TIP_LABELS: Record<TipKind, string> = {
  prompt: "A little prompt",
  fact: "Did you know?",
  quote: "Something to sit with",
  nudge: "Gentle reminder",
  recommendation: "Just for you",
};

export const MASCOT_TIPS: MascotTip[] = [
  // Prompts — things to talk about on camera
  { kind: "prompt", context: "upload", text: "What was the smallest good thing that happened today?" },
  { kind: "prompt", context: "upload", text: "Describe where you are right now. What can you hear?" },
  { kind: "prompt", context: "upload", text: "What's taking up the most room in your head this week?" },
  { kind: "prompt", context: "upload", text: "Who made your day a little easier lately? Tell them here first." },
  { kind: "prompt", context: "upload", text: "What would you tell yourself from one year ago?" },
  { kind: "prompt", context: "upload", text: "Name one thing you're looking forward to, even a tiny one." },
  { kind: "prompt", context: "upload", text: "What did your body need today? Did it get it?" },
  { kind: "prompt", context: "upload", text: "Talk through a decision you're stuck on. No need to solve it." },
  { kind: "prompt", text: "What's something you learned recently that surprised you?" },
  { kind: "prompt", text: "If today had a weather forecast, what would it be?" },

  // Did you know — kept to well-established findings
  { kind: "fact", text: "Psychologist James Pennebaker found that writing about feelings for 15–20 minutes a few days in a row was linked to fewer doctor visits." },
  { kind: "fact", text: "Simply putting a feeling into words — “I feel anxious” — can dial down activity in the brain's alarm center. Researchers call it affect labeling." },
  { kind: "fact", text: "Talking to yourself by name (“Okay, Sam, you've got this”) can make stressful moments feel more manageable." },
  { kind: "fact", text: "In one study, people who jotted down a few things they were grateful for each week felt more optimistic about the week ahead." },
  { kind: "fact", text: "Your voice carries emotion that text can't — tone, pace, pauses. Video journals keep all of it." },
  { kind: "fact", text: "Every dog's nose print is unique, a bit like a fingerprint. Every journal entry is, too." },
  { kind: "fact", context: "history", text: "Re-watching old entries can help you notice patterns you'd never spot in the moment." },

  // Quotes — short, classic, attributed
  { kind: "quote", text: "Knowing yourself is the beginning of all wisdom.", by: "Aristotle" },
  { kind: "quote", text: "Life can only be understood backwards; but it must be lived forwards.", by: "Søren Kierkegaard" },
  { kind: "quote", text: "Nothing is worth more than this day.", by: "Johann Wolfgang von Goethe" },
  { kind: "quote", text: "Adopt the pace of nature: her secret is patience.", by: "Ralph Waldo Emerson" },
  { kind: "quote", text: "Be not afraid of growing slowly; be afraid only of standing still.", by: "Chinese proverb" },

  // Gentle nudges
  { kind: "nudge", context: "upload", text: "No need for a perfect take. Rambling counts. Pauses count." },
  { kind: "nudge", context: "upload", text: "Even a one-minute entry is a whole entry. I'm proud of you already." },
  { kind: "nudge", text: "Take one slow breath before you start. In for four… out for six." },
  { kind: "nudge", text: "Grab something warm to drink. I'll wait right here." },
  { kind: "nudge", context: "history", text: "Look how far you've come. Be kind to the person in these videos." },
];
