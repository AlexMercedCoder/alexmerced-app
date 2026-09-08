import { snapShift } from './enhancements';
const snapping = new WeakMap<HTMLElement, (id: string) => number[]>();
export function snapTrack(
  element: HTMLElement,
  id: string,
  edge: 'start' | 'end' | 'move',
  start: number,
  end: number,
  shift: number,
  duration: number,
): number {
  const root = element.closest<HTMLElement>('#limelight-root');
  if (!root || !root.querySelector<HTMLInputElement>('#ll-timeline-snap')?.checked) return shift;
  const targets = snapping.get(root)?.(id) ?? [];
  return snapShift(
    edge,
    start,
    end,
    shift,
    targets,
    (duration / Math.max(1, element.getBoundingClientRect().width)) * 8,
  );
}
export function mountTimelineView(
  root: HTMLElement,
  targets: (id: string) => number[],
  position: () => number,
) {
  snapping.set(root, targets);
  const wraps: HTMLElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(
    '.ll-zoomtrack, #ll-wavewrap, #ll-trim',
  )) {
    const wrapper = document.createElement('div');
    wrapper.className = 'll-timeline-viewport';
    element.before(wrapper);
    wrapper.append(element);
    wraps.push(wrapper);
    wrapper.addEventListener('scroll', () => {
      const proportion =
        wrapper.scrollLeft / Math.max(1, wrapper.scrollWidth - wrapper.clientWidth);
      for (const other of wraps)
        if (other !== wrapper) {
          const target = proportion * (other.scrollWidth - other.clientWidth);
          if (Math.abs(other.scrollLeft - target) > 1) other.scrollLeft = target;
        }
    });
  }
  const zoom = root.querySelector<HTMLSelectElement>('#ll-timeline-zoom')!;
  const center = () => {
    for (const wrapper of wraps)
      wrapper.scrollLeft = position() * wrapper.scrollWidth - wrapper.clientWidth / 2;
  };
  zoom.addEventListener('change', () => {
    for (const wrapper of wraps)
      (wrapper.firstElementChild as HTMLElement).style.width = `${Number(zoom.value) * 100}%`;
    center();
  });
  root.querySelector('#ll-timeline-center')!.addEventListener('click', center);
}
