import type { ComponentType } from 'react'
import { Sheet } from './Sheet'
import { ChevronRight } from './icons'

export interface SheetAction {
  title: string
  desc?: string
  Icon: ComponentType<{ size?: number }>
  onSelect: () => void
}

/** A titled list of actions, styled like the "New" sheet. */
export function ActionSheet({ title, actions, onClose }: { title: string; actions: SheetAction[]; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="choice-list">
        {actions.map(({ title: label, desc, Icon, onSelect }) => (
          <button key={label} className="choice" onClick={onSelect}>
            <Icon />
            <span className="choice__text">
              <span className="choice__title">{label}</span>
              {desc && <span className="choice__desc">{desc}</span>}
            </span>
            <ChevronRight size={16} className="chevron" />
          </button>
        ))}
      </div>
    </Sheet>
  )
}
