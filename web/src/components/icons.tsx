// App-wide icon set: Lucide, re-exported under Orca's names with one default stroke weight.
import type { LucideIcon, LucideProps } from 'lucide-react'
import {
  ArrowLeft,
  ArrowUp,
  ArrowRightToLine,
  ClipboardList,
  FastForward,
  Pause,
  ShieldOff,
  Zap,
  Bell as LucideBell,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronUp as LucideChevronUp,
  CornerDownLeft,
  Download as LucideDownload,
  Ellipsis,
  GitBranch,
  ImagePlus as LucideImagePlus,
  Images as LucideImages,
  Keyboard as LucideKeyboard,
  LayoutGrid,
  Mic as LucideMic,
  OctagonX,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  RefreshCw,
  Search as LucideSearch,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'

const withDefaults = (Icon: LucideIcon) => {
  const Wrapped = ({ size = 20, strokeWidth = 1.75, ...rest }: LucideProps) => (
    <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" {...rest} />
  )
  return Wrapped
}

export const Back = withDefaults(ArrowLeft)
export const ChevronDown = withDefaults(LucideChevronDown)
export const ChevronLeft = withDefaults(LucideChevronLeft)
export const ChevronRight = withDefaults(LucideChevronRight)
export const ChevronUp = withDefaults(LucideChevronUp)
export const Shells = withDefaults(SquareTerminal)
export const Bell = withDefaults(LucideBell)
export const Plus = withDefaults(LucidePlus)
export const Close = withDefaults(X)
export const Check = withDefaults(LucideCheck)
export const Sparkle = withDefaults(Sparkles)
export const Branch = withDefaults(GitBranch)
export const Space = withDefaults(LayoutGrid)
export const Terminal = withDefaults(SquareTerminal)
export const Media = withDefaults(LucideImages)
export const More = withDefaults(Ellipsis)
export const Pencil = withDefaults(LucidePencil)
export const Trash = withDefaults(Trash2)

// Claude permission modes
export const ModeManual = withDefaults(Pause)
export const ModeAcceptEdits = withDefaults(FastForward)
export const ModePlan = withDefaults(ClipboardList)
export const ModeAuto = withDefaults(Zap)
export const ModeBypass = withDefaults(ShieldOff)
export const Download = withDefaults(LucideDownload)
export const Refresh = withDefaults(RefreshCw)
export const Search = withDefaults(LucideSearch)

// Terminal key bar
export const Keyboard = withDefaults(LucideKeyboard)
export const AttachImage = withDefaults(LucideImagePlus)
export const Mic = withDefaults(LucideMic)
export const Send = withDefaults(ArrowUp)
export const KeyEsc = withDefaults(X)
export const KeyTab = withDefaults(ArrowRightToLine)
export const KeyEnter = withDefaults(CornerDownLeft)
export const KeyInterrupt = withDefaults(OctagonX)
