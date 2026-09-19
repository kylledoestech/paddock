import type { AgentStatus } from '../types/herdr'

const labels: Record<AgentStatus, string> = {
  blocked: 'Needs input',
  done: 'Done',
  working: 'Working',
  idle: 'Idle',
  unknown: 'Unknown',
}

export function StatusDot({ status, small }: { status: AgentStatus; small?: boolean }) {
  return (
    <span
      className={`dot dot--${status}${small ? ' dot--small' : ''}`}
      role="img"
      aria-label={labels[status]}
    />
  )
}
