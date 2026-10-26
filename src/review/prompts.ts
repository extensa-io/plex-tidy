import { confirm, input, select } from '@inquirer/prompts';
import type { ReviewIO } from './review.ts';

/** The real terminal, using @inquirer/prompts. */
export function createTerminalIO(): ReviewIO {
  return {
    print: (line) => {
      console.log(line);
    },
    confirm: (message) => confirm({ message, default: false }),
    choose: (message, choices) =>
      select({ message, choices: choices.map((choice) => ({ value: choice.value, name: choice.label })) }),
    ask: (message) => input({ message }),
  };
}
