// Nav icon: the Buddy still, sized like the SVG icons it sits beside.
export default function BuddyIcon({ width = 17, height = 17 }) {
  return (
    <img
      src="/mascot/buddy-calm-128.png"
      alt=""
      aria-hidden="true"
      width={width}
      height={height}
      style={{ objectFit: 'contain', transform: 'scale(1.35)' }}
      draggable="false"
    />
  );
}
