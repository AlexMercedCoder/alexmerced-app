/** Small transient messages, with an optional undo affordance. */
export type ToastKind = 'plain' | 'error' | 'good';

type ToastOptions = {
  kind?: ToastKind;
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
};

export function toast(message: string, options: ToastOptions = {}): void {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;

  const { kind = 'plain', duration = options.onAction ? 7000 : 3800 } = options;

  const element = document.createElement('div');
  element.className = `toast${kind === 'plain' ? '' : ` toast--${kind}`}`;

  const text = document.createElement('span');
  text.textContent = message;
  element.appendChild(text);

  let timer: number;
  const dismiss = () => {
    window.clearTimeout(timer);
    element.remove();
  };

  if (options.onAction && options.actionLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast__action';
    button.textContent = options.actionLabel;
    button.addEventListener('click', () => {
      options.onAction!();
      dismiss();
    });
    element.appendChild(button);
  }

  stack.appendChild(element);
  timer = window.setTimeout(dismiss, duration);
}
