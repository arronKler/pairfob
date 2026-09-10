import { fileIconFor, fileIconGlyph, type FileKind } from "./file-icon-model";

export function FileIcon({
  kind,
  name,
  path,
}: {
  kind?: FileKind;
  name?: string;
  path?: string;
}) {
  const fileName = name || path || "";
  const id = fileIconFor(kind, fileName);
  return (
    <svg
      className="file-icon"
      data-file-icon={id}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {fileIconGlyph(id).map((part, index) => (
        <path
          key={index}
          d={part.d}
          fill={part.stroke ? "none" : "currentColor"}
          fillRule={part.evenodd ? "evenodd" : undefined}
          stroke={part.stroke ? "currentColor" : undefined}
          strokeWidth={part.stroke ? part.width ?? 1.25 : undefined}
          strokeLinecap={part.stroke ? "round" : undefined}
          strokeLinejoin={part.stroke ? "round" : undefined}
          transform={part.transform}
        />
      ))}
    </svg>
  );
}
