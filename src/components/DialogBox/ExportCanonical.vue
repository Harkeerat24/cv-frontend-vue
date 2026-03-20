<template>
    <v-dialog
        v-model="SimulatorState.dialogBox.export_canonical_dialog"
        :persistent="false"
    >
        <v-card class="exportCanonicalCard">
            <v-card-text>
                <p class="dialogHeader">Export Canonical JSON</p>

                <v-btn
                    size="x-small"
                    icon
                    class="dialogClose"
                    @click="SimulatorState.dialogBox.export_canonical_dialog = false"
                >
                    <v-icon>mdi-close</v-icon>
                </v-btn>

                <p v-if="isLoading" class="canonical-info">Generating canonical JSON…</p>

                <div v-if="previewCode" class="preview-container">
                    <Codemirror
                        id="canonical-export-code-window"
                        :value="previewCode"
                        :options="cmOptions"
                        border
                        :height="300"
                    />
                </div>
            </v-card-text>

            <v-card-actions>
                <v-btn class="messageBtn canonicalBtn" block @click="downloadCanonical">
                    Download .json
                </v-btn>
                <v-btn class="messageBtn canonicalBtn" block @click="copyToClipboardAction">
                    Copy to Clipboard
                </v-btn>
                <v-btn class="messageBtn canonicalBtn" block @click="previewOrRefreshCanonical">
                    {{ previewCode ? 'Refresh JSON' : 'Preview JSON' }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script lang="ts">
import { useState as useSimulatorState } from '../../store/SimulatorStore/state'

export function ExportCanonical() {
    const SimulatorState = useSimulatorState()
    SimulatorState.dialogBox.export_canonical_dialog = true
}
</script>

<script lang="ts" setup>
import { ref, watch } from 'vue'
import { useState } from '../../store/SimulatorStore/state'
import { useProjectStore } from '../../store/projectStore'
import { canonicaliseScope } from '../../simulator/src/data/canonical'
import { downloadFile, showMessage } from '../../simulator/src/utils'
import { scopeList } from '../../simulator/src/circuit'
import Codemirror from 'codemirror-editor-vue3'
import 'codemirror/mode/javascript/javascript.js'
import 'codemirror/theme/dracula.css'

const SimulatorState = useState()
const projectStore = useProjectStore()

const canonicalData = ref<any>({})
const previewCode = ref('')
const isLoading = ref(false)

const cmOptions = {
    mode: 'application/json',
    theme: 'dracula',
    lineNumbers: true,
    readOnly: true,
    autoRefresh: true,
}

// To get all vaild scopes for export
const getExportScopes = () => {
    const allScopes = Object.values(scopeList || {}) as any[]
    const validScopes = allScopes.filter((scope) => Array.isArray(scope?.allNodes))

    //Sorting Deterministically
    validScopes.sort((scopeA, scopeB) => {
        const idA = String(scopeA?.id ?? '')
        const idB = String(scopeB?.id ?? '')
        if (idA < idB) return -1
        if (idA > idB) return 1
        const nameA = String(scopeA?.name ?? '')
        const nameB = String(scopeB?.name ?? '')
        if (nameA < nameB) return -1
        if (nameA > nameB) return 1
        return 0
    })

    return validScopes
}

const refreshCanonical = async () => {
    isLoading.value = true
    const scopes = getExportScopes()
    canonicalData.value = await canonicaliseScope(scopes)
    previewCode.value = JSON.stringify(canonicalData.value, null, 2)
    isLoading.value = false
}

const previewOrRefreshCanonical = async () => {
    await refreshCanonical()
}

watch(
    () => SimulatorState.dialogBox.export_canonical_dialog,
    async (isOpen) => {
        if (isOpen) {
            canonicalData.value = {}
            previewCode.value = ''
        }
    }
)

const downloadCanonical = () => {
    if (!canonicalData.value) return
    const name = projectStore.getProjectName || 'untitled'
    const fileName = `${name}_canonical.json`
    downloadFile(fileName, previewCode.value)
    SimulatorState.dialogBox.export_canonical_dialog = false
}

const copyToClipboardAction = async () => {
    if (!previewCode.value) return
    await navigator.clipboard.writeText(previewCode.value)
    showMessage('Canonical JSON copied to clipboard')
}
</script>

<style scoped>
.exportCanonicalCard {
    height: auto;
    width: 45rem;
    justify-content: center;
    margin: auto;
    backdrop-filter: blur(5px);
    border-radius: 5px;
    border: 0.5px solid var(--br-primary) !important;
    background: var(--bg-primary-moz) !important;
    background-color: var(--bg-primary-chr) !important;
    color: white;
}

.dialogHeader {
    font-size: 1.5rem;
    margin-bottom: 1rem;
    text-align: center;
}

.canonical-info {
    margin-bottom: 1rem;
    font-size: 0.9rem;
    color: #ccc;
    text-align: center;
}

.preview-container {
    margin-top: 1rem;
    border: 1px solid #444;
    width: 100%;
}

:deep(#canonical-export-code-window .CodeMirror) {
    width: 100% !important;
}

.canonicalBtn {
    border: 1px solid #ffffff !important;
}

.canonicalBtn:focus,
.canonicalBtn:focus-visible,
.canonicalBtn:active {
    border: 1px solid #ffffff !important;
    outline: none !important;
    box-shadow: none !important;
}

.dialogClose {
    position: absolute;
    top: 5px;
    right: 5px;
}
</style>
