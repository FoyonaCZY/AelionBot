import type { BotType } from '../../shared/types/designer-types';

/** Illustration and selection tick on a Bot type card. */
export function BotTypeArt({ type }: { type: BotType }) {
  return (
    <span className="bot-type-art" aria-hidden="true">
      <svg viewBox="0 0 260 84" fill="none" preserveAspectRatio="xMidYMid slice">
        {type === 'general' ? (
          <>
            <rect
              x="50"
              y="16"
              width="89"
              height="62"
              rx="5"
              fill="var(--type-paper)"
              stroke="var(--type-rule)"
              transform="rotate(-8 50 16)"
            />
            <path
              d="M64 31L105 25M66 42L114 35M67 52L92 48"
              stroke="var(--type-rule)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <rect x="106" y="25" width="105" height="64" rx="6" fill="var(--type-terminal)" />
            <circle cx="118" cy="36" r="2" fill="#AABBB5" />
            <circle cx="126" cy="36" r="2" fill="#788E88" />
            <path
              d="M122 50L128 55L122 60M136 60H154"
              stroke="#E4ECE6"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M223 15V27M217 21H229" stroke="var(--type-rule)" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx="177" cy="29" r="44" fill="var(--type-sun)" />
            <path d="M137 91V40C137 21 151 8 168 8C187 8 201 22 201 40V91" stroke="var(--type-ink)" strokeWidth="1.2" />
            <rect
              x="60"
              y="8"
              width="62"
              height="81"
              rx="1"
              fill="var(--type-paper)"
              stroke="var(--type-rule)"
              transform="rotate(-12 60 8)"
            />
            <path d="M59 75C69 44 86 31 112 43C133 53 135 76 153 83" fill="var(--type-leaf)" />
            <ellipse cx="106" cy="38" rx="17" ry="25" transform="rotate(28 106 38)" fill="var(--type-clay)" />
            <path
              d="M90 72C119 54 144 68 157 83M212 61L218 47L224 61L238 67L224 73L218 87L212 73L198 67Z"
              stroke="var(--type-ink)"
              strokeWidth="1.2"
            />
          </>
        )}
      </svg>
      <span className="bot-type-selected">
        <svg viewBox="0 0 16 16">
          <path
            d="m4 8 2.5 2.5L12 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </span>
  );
}
