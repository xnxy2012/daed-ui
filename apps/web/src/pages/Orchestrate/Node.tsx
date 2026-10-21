import type { QRCodeModalRef } from '~/components/QRCodeModal.tsx'
import type { NodesQuery } from '~/schemas/gql/graphql.ts'
import type { NodeLatencyProbeResult } from '~/apis'
import { Droppable } from '@hello-pangea/dnd'
import { useStore } from '@nanostores/react'
import { ChevronDown, ChevronUp, Cloud, CloudUpload, Eye, FileInput, Gauge, Pencil } from 'lucide-react'
import { Fragment, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useImportNodesMutation, useRemoveNodesMutation } from '~/apis/index.ts'
import { EditNodeFormModal } from '~/components/EditNodeFormModal.tsx'
import { ImportResourceFormModal } from '~/components/ImportResourceFormModal.tsx'
import { ConfigureNodeFormModal, SortableNodeCard } from '~/components/index.ts'
import { QRCodeModal } from '~/components/QRCodeModal.tsx'
import { Section } from '~/components/Section.tsx'
import { Button } from '~/components/ui/button.tsx'
import { SimpleTooltip } from '~/components/ui/tooltip.tsx'
import { cn } from '~/lib/utils'
import { nodeListCollapsedAtom, nodeListExpandedAtom } from '~/store'
import { formatLatencyLabel } from '~/utils/latency'

export const NODE_DROPPABLE_ID = 'node-list'

// Cards shown before the "show all" toggle. Only a prefix is rendered so drag indexes stay valid.
const NODE_PREVIEW_COUNT = 8

export function NodeResource({
  sortedNodes,
  highlight,
  nodeLatencies,
  testingLatencies,
  onTestNodeLatencies,
}: {
  sortedNodes: NodesQuery['nodes']['edges']
  highlight?: boolean
  nodeLatencies?: Record<string, NodeLatencyProbeResult>
  testingLatencies?: boolean
  /** Omit ids to test every node. */
  onTestNodeLatencies?: (ids?: string[]) => Promise<void>
}) {
  const { t } = useTranslation()
  const collapsed = useStore(nodeListCollapsedAtom)
  const expandedAll = useStore(nodeListExpandedAtom)
  const visibleNodes = collapsed ? [] : expandedAll ? sortedNodes : sortedNodes.slice(0, NODE_PREVIEW_COUNT)
  const hiddenCount = sortedNodes.length - visibleNodes.length
  const runTest = (ids?: string[]) => {
    onTestNodeLatencies?.(ids).catch((error) => {
      console.error('Failed to test node latencies', error)
      toast.error(error instanceof Error ? error.message : t('latency.unavailable'))
    })
  }

  const [openedQRCodeModal, setOpenedQRCodeModal] = useState(false)
  const [openedImportNodeFormModal, setOpenedImportNodeFormModal] = useState(false)
  const [openedConfigureNodeFormModal, setOpenedConfigureNodeFormModal] = useState(false)
  const [openedEditNodeFormModal, setOpenedEditNodeFormModal] = useState(false)
  const [editingNode, setEditingNode] = useState<{
    id: string
    link: string
    tag: string
    name: string
  }>()
  const qrCodeModalRef = useRef<QRCodeModalRef>(null)
  const removeNodesMutation = useRemoveNodesMutation()
  const importNodesMutation = useImportNodesMutation()

  return (
    <Section
      title={t('node')}
      icon={<Cloud className="h-5 w-5" />}
      iconPlus={<CloudUpload className="h-4 w-4" />}
      onCreate={() => setOpenedImportNodeFormModal(true)}
      actions={
        <Fragment>
          {sortedNodes.length > 0 && onTestNodeLatencies && (
            <SimpleTooltip label={t('latency.testAllNodes')}>
              <Button variant="ghost" size="icon" onClick={() => runTest()} loading={testingLatencies}>
                <Gauge className="h-4 w-4" />
              </Button>
            </SimpleTooltip>
          )}
          <SimpleTooltip label={t('actions.configureNode')}>
            <Button variant="ghost" size="icon" onClick={() => setOpenedConfigureNodeFormModal(true)}>
              <FileInput className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          {sortedNodes.length > 0 && (
            <SimpleTooltip label={collapsed ? t('nodeList.expand') : t('nodeList.collapse')}>
              <Button variant="ghost" size="icon" onClick={() => nodeListCollapsedAtom.set(!collapsed)}>
                {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </Button>
            </SimpleTooltip>
          )}
        </Fragment>
      }
      bordered
      highlight={highlight}
    >
      <Droppable droppableId={NODE_DROPPABLE_ID} type="NODE">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn('flex flex-col gap-3', collapsed ? 'min-h-[40px]' : 'min-h-[100px]', snapshot.isDraggingOver && 'bg-primary/5 rounded-lg')}
          >
            {visibleNodes.map(({ id, name, tag, protocol, link }, index) => (
              <SortableNodeCard
                key={id}
                id={`node-${id}`}
                index={index}
                name={tag || name}
                leftSection={protocol}
                actions={
                  <Fragment>
                    {onTestNodeLatencies && (
                      <SimpleTooltip label={t('latency.testNode')}>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                          disabled={testingLatencies}
                          onClick={() => runTest([id])}
                        >
                          <Gauge className="h-3.5 w-3.5" />
                        </Button>
                      </SimpleTooltip>
                    )}
                    <SimpleTooltip label={t('actions.edit')}>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setEditingNode({
                            id,
                            link,
                            tag: tag || '',
                            name: name || '',
                          })
                          setOpenedEditNodeFormModal(true)
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </SimpleTooltip>
                    <SimpleTooltip label={t('actions.viewQRCode')}>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          qrCodeModalRef.current?.setProps({
                            name: tag || name!,
                            link,
                          })
                          setOpenedQRCodeModal(true)
                        }}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </SimpleTooltip>
                  </Fragment>
                }
                onRemove={() => removeNodesMutation.mutate([id])}
              >
                {nodeLatencies?.[id] && (
                  <p className="text-xs font-medium text-primary">
                    {formatLatencyLabel(nodeLatencies[id], t)}
                  </p>
                )}
                {name && name !== tag && <p className="text-xs opacity-70">{name}</p>}
                <Spoiler label={link} showLabel={t('actions.show sensitive')} hideLabel={t('actions.hide')} />
              </SortableNodeCard>
            ))}
            {provided.placeholder}
            {sortedNodes.length > 0 && collapsed && (
              <button
                type="button"
                className="rounded-lg border border-dashed py-2 text-center text-xs text-muted-foreground hover:bg-muted"
                onClick={() => nodeListCollapsedAtom.set(false)}
              >
                {t('nodeList.collapsedHint', { count: sortedNodes.length })}
              </button>
            )}
            {!collapsed && sortedNodes.length > NODE_PREVIEW_COUNT && (
              <button
                type="button"
                className="rounded-lg border border-dashed py-2 text-center text-xs text-primary hover:bg-muted"
                onClick={() => nodeListExpandedAtom.set(!expandedAll)}
              >
                {expandedAll ? t('nodeList.showLess') : t('nodeList.showAll', { count: hiddenCount })}
              </button>
            )}
          </div>
        )}
      </Droppable>

      <QRCodeModal ref={qrCodeModalRef} opened={openedQRCodeModal} onClose={() => setOpenedQRCodeModal(false)} />

      <ImportResourceFormModal
        title={t('node')}
        opened={openedImportNodeFormModal}
        onClose={() => setOpenedImportNodeFormModal(false)}
        handleSubmit={async (values) => {
          await importNodesMutation.mutateAsync(values.resources.map(({ link, tag }) => ({ link, tag })))
        }}
      />

      <ConfigureNodeFormModal
        opened={openedConfigureNodeFormModal}
        onClose={() => setOpenedConfigureNodeFormModal(false)}
      />

      <EditNodeFormModal
        opened={openedEditNodeFormModal}
        onClose={() => setOpenedEditNodeFormModal(false)}
        node={editingNode}
      />
    </Section>
  )
}

function Spoiler({ label, showLabel, hideLabel }: { label: string; showLabel: string; hideLabel: string }) {
  const [show, setShow] = useState(false)

  return (
    <div>
      {show && <p className="text-sm break-all">{label}</p>}
      <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShow(!show)}>
        {show ? hideLabel : showLabel}
      </button>
    </div>
  )
}
