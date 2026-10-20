// The Connect dialog's "Coding agent" tab: how an agent reaches this engine
// through `firenook mcp`. When an agent last called comes first, so the tab
// also answers "is it working?"; then `npx firenook mcp add`, which writes
// every agent's project file at once (the console writes no files: changing
// the repository stays a command with a plan and a dry run); then each
// agent on its own — its command or install link, and its project file.
//
// Project files never name the project, because they are committed and
// shared and the server finds the one suite running. What goes in a
// person's own settings (Claude Code's user scope, the editors' install
// links, the generic entry) takes `--project <id>` when they say more than
// one emulator runs on their machine.

import { Checkbox, LinkButton, Tabs, Text } from '@cloudflare/kumo'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { CodeBlock } from '@/components/console/code-block'
import { RelativeTime } from '@/components/console/relative-time'
import { PanelTitle, StatusDot } from '@/components/kit'
import {
  AGENT_FILES,
  MCP_ADD_COMMAND,
  claudeCommand,
  cursorInstallLink,
  mcpServersJson,
  vscodeInstallLink,
  vscodeJson,
} from '@/lib/agent-config'
import { errorText } from '@/lib/error-text'
import { agentsQuery } from './agents-query'

type Agent = 'claude' | 'cursor' | 'vscode' | 'other'

const AGENTS: readonly { value: Agent; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'other', label: 'Other agents' },
]

/** A line of mono set inside a sentence. */
function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.9em]">{children}</span>
}

/** A sentence under a block: what it does, or what happens next. */
function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="max-w-[72ch] text-[13px] text-kumo-subtle" data-testid={testId}>
      {children}
    </p>
  )
}

export function AgentSetup({ project }: { project: string }) {
  const [agent, setAgent] = useState<Agent>('claude')
  const [named, setNamed] = useState(false)
  // Only what goes in someone's own settings names the project.
  const own = named ? project : undefined
  return (
    <div className="grid min-w-0 content-start gap-6" data-testid="connect-agent">
      <LastCall />
      <section className="grid min-w-0 gap-2">
        <CodeBlock
          label="Set up every agent in this project"
          code={MCP_ADD_COMMAND}
          language="shell"
          testId="agent-mcp-add"
        />
        <Note>
          Run it in your project’s folder. It writes the MCP file of each agent it finds there and
          says what it wrote; add <Mono>--dry-run</Mono> to see the plan first.
        </Note>
      </section>
      <section className="grid min-w-0 gap-3 border-t border-kumo-line pt-5">
        <PanelTitle as="h4">Or one agent at a time</PanelTitle>
        <div className="flex" data-testid="agent-tabs">
          <Tabs
            variant="segmented"
            size="sm"
            value={agent}
            onValueChange={(value) => setAgent(value as Agent)}
            tabs={AGENTS.map((entry) => ({ value: entry.value, label: entry.label }))}
          />
        </div>
        <div className="grid min-w-0 gap-4" data-testid={`agent-${agent}`}>
          {agent === 'claude' ? (
            <>
              <CodeBlock
                label="Add it to this project"
                code={claudeCommand('project')}
                language="shell"
                testId="agent-claude-project"
              />
              <CodeBlock
                label={`Or write ${AGENT_FILES.claude} yourself`}
                code={mcpServersJson()}
                language="json"
                testId="agent-claude-file"
              />
              <CodeBlock
                label="Or add it for all your projects"
                code={claudeCommand('user', own)}
                language="shell"
                testId="agent-claude-user"
              />
              <Note>Claude Code asks you to approve a project’s server before it first runs.</Note>
            </>
          ) : agent === 'cursor' ? (
            <>
              <InstallLinks
                links={[{ label: 'Add to Cursor', href: cursorInstallLink(own), testId: 'cursor' }]}
                editor="Cursor"
              />
              <CodeBlock
                label={`Or add ${AGENT_FILES.cursor} to the project`}
                code={mcpServersJson()}
                language="json"
                testId="agent-cursor-file"
              />
            </>
          ) : agent === 'vscode' ? (
            <>
              <InstallLinks
                links={[
                  { label: 'Add to VS Code', href: vscodeInstallLink(own), testId: 'vscode' },
                  {
                    label: 'Add to VS Code Insiders',
                    href: vscodeInstallLink(own, true),
                    testId: 'vscode-insiders',
                  },
                ]}
                editor="VS Code"
              />
              <CodeBlock
                label={`Or add ${AGENT_FILES.vscode} to the project`}
                code={vscodeJson()}
                language="json"
                testId="agent-vscode-file"
              />
            </>
          ) : (
            <>
              <CodeBlock
                label="The server, as most agents’ MCP settings take it"
                code={mcpServersJson(own)}
                language="json"
                testId="agent-other-entry"
              />
              <Note>
                Add it where your agent keeps its MCP servers. <Mono>npx firenook mcp</Mono> finds
                the emulator running on this machine by itself.
              </Note>
            </>
          )}
        </div>
        <div className="grid gap-1 pt-1">
          <Checkbox
            checked={named}
            onCheckedChange={(checked) => setNamed(Boolean(checked))}
            label="More than one emulator runs on this machine"
          />
          <span className="pl-6">
            <Text variant="secondary" size="sm">
              Names this project, <Mono>--project {project}</Mono>, wherever the server goes in your
              own settings, so the agent reaches this emulator. Project files never do: they are
              shared.
            </Text>
          </span>
        </div>
      </section>
    </div>
  )
}

/** An editor's install links, and that it asks before it adds anything. */
function InstallLinks({
  links,
  editor,
}: {
  links: readonly { label: string; href: string; testId: string }[]
  editor: string
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {links.map((link, index) => (
          <LinkButton
            key={link.testId}
            href={link.href}
            variant={index === 0 ? 'primary' : 'secondary'}
            size="sm"
            icon={<ArrowSquareOutIcon />}
            data-testid={`agent-${link.testId}-install`}
          >
            {link.label}
          </LinkButton>
        ))}
      </div>
      <Note>{editor} asks you to confirm before it adds the server to your settings.</Note>
    </div>
  )
}

/**
 * When an agent last called, from the MCP server's beacon: read as the tab
 * opens and when the window is focused again, never polled.
 */
function LastCall() {
  const agents = useQuery(agentsQuery)
  const last = agents.data?.lastCall
  return (
    <div
      className="flex min-h-5 min-w-0 items-center gap-2 text-[14px]"
      data-testid="agent-last-call"
      data-state={
        agents.isPending ? 'loading' : agents.isError ? 'error' : last ? 'called' : 'none'
      }
    >
      {agents.isPending ? null : agents.isError ? (
        <span className="text-kumo-subtle">
          When an agent last called could not be read: {errorText(agents.error)}
        </span>
      ) : last ? (
        <>
          <StatusDot tone="success" label="An agent has called" hideLabel />
          <span className="min-w-0 truncate" data-testid="agent-last-call-text">
            Last call <RelativeTime iso={last.at} className="text-[14px]" />:{' '}
            <Mono>{last.tool}</Mono> <span className="text-kumo-subtle">({last.client})</span>
          </span>
        </>
      ) : (
        <>
          <StatusDot tone="neutral" label="No agent has called" hideLabel />
          <span className="text-kumo-subtle" data-testid="agent-last-call-text">
            No agent has called yet.
          </span>
        </>
      )}
    </div>
  )
}
