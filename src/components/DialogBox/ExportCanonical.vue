<template>
    <v-dialog
        v-model="SimulatorState.dialogBox.export_canonical_dialog"
        :persistent="true"
    >
        <v-card class="exportCanonicalCard">
            <v-card-text>
                <p class="dialogHeader">Export Canonical Format</p>
                <v-btn
                    size="x-small"
                    icon
                    class="dialogClose"
                    @click="
                        SimulatorState.dialogBox.export_canonical_dialog = false
                    "
                >
                    <v-icon>mdi-close</v-icon>
                </v-btn>
                <p class="dialogDescription">
                    Export your circuit in a universal, simulator-agnostic
                    canonical JSON format. This format separates logical
                    netlist from visual layout, making circuits portable
                    across different simulators.
                </p>
                <div class="fileNameInput">
                    <p>File name:</p>
                    <input
                        v-model="fileNameInput"
                        id="canonicalFileNameInput"
                        class="inputField"
                        type="text"
                        placeholder="untitled"
                        required
                    />
                    <p>.canonical.json</p>
                </div>
                <div v-if="previewData" class="canonicalPreview">
                    <p class="previewLabel">Preview:</p>
                    <pre class="previewContent">{{ previewData }}</pre>
                </div>
            </v-card-text>
            <v-card-actions>
                <v-btn class="messageBtn" @click="preview">
                    Preview
                </v-btn>
                <v-btn class="messageBtn" @click="exportCanonical">
                    Download
                </v-btn>
                <v-btn class="messageBtn" @click="copyToClipboardAction">
                    Copy to Clipboard
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script lang="ts">
import { ref } from 'vue'
import { useState } from '#/store/SimulatorStore/state'
import { useProjectStore } from '#/store/projectStore'

export function ExportCanonical() {
    const SimulatorState = useState()
    SimulatorState.dialogBox.export_canonical_dialog = true
    setTimeout(() => {
        const input = document.getElementById(
            'canonicalFileNameInput'
        ) as HTMLInputElement
        input?.select()
    }, 100)
}
</script>

<script lang="ts" setup>
import { generateCanonicalData } from '#/simulator/src/data/canonicalExport'
import { downloadFile } from '#/simulator/src/utils'
import { escapeHtml, copyToClipboard, showMessage } from '#/simulator/src/utils'

const SimulatorState = useState()
const projectStore = useProjectStore()

const fileNameInput = ref(
    projectStore.getProjectName +
        '__' +
        new Date().toLocaleString().replace(/[: \/,-]/g, '_')
)

const previewData = ref('')

const preview = () => {
    try {
        const data = generateCanonicalData()
        // Show first 2000 chars in preview
        previewData.value =
            data.length > 2000 ? data.substring(0, 2000) + '\n...(truncated)' : data
    } catch (e) {
        previewData.value = `Error generating canonical data: ${e.message}`
    }
}

const exportCanonical = () => {
    try {
        let fileName = escapeHtml(fileNameInput.value) || 'untitled'
        const canonicalData = generateCanonicalData()
        fileName = `${fileName.replace(/[^a-z0-9]/gi, '_')}.canonical.json`
        downloadFile(fileName, canonicalData)
        SimulatorState.dialogBox.export_canonical_dialog = false
    } catch (e) {
        showMessage(`Error: ${e.message}`)
    }
}

const copyToClipboardAction = () => {
    try {
        const canonicalData = generateCanonicalData()
        copyToClipboard(canonicalData)
        showMessage('Canonical JSON copied to clipboard')
    } catch (e) {
        showMessage(`Error: ${e.message}`)
    }
}
</script>

<style scoped>
.exportCanonicalCard {
    height: auto;
    max-width: 50rem;
    width: 90%;
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
    font-size: 1.2rem;
    font-weight: bold;
    margin-bottom: 0.5rem;
}

.dialogDescription {
    font-size: 0.85rem;
    opacity: 0.8;
    margin-bottom: 1rem;
    line-height: 1.4;
}

.fileNameInput {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
}

.fileNameInput .inputField {
    flex: 1;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--br-primary);
    border-radius: 4px;
    background: transparent;
    color: white;
    outline: none;
}

.fileNameInput .inputField:focus {
    border-color: var(--primary);
}

.canonicalPreview {
    margin-top: 1rem;
    max-height: 300px;
    overflow-y: auto;
}

.previewLabel {
    font-size: 0.85rem;
    font-weight: bold;
    margin-bottom: 0.3rem;
}

.previewContent {
    font-size: 0.75rem;
    background: rgba(0, 0, 0, 0.3);
    padding: 0.5rem;
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 250px;
    overflow-y: auto;
}

@media screen and (max-width: 991px) {
    .exportCanonicalCard {
        width: 100%;
    }
}
</style>
