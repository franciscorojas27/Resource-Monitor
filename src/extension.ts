import * as vscode from 'vscode';
import * as si from 'systeminformation';
import pidusage from 'pidusage';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as os from 'os';

const getNonce = () => {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => possible.charAt(Math.floor(Math.random() * possible.length))).join('');
};

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel("NetMonitor-Debug");
    log.show();
    log.appendLine("Extension Started...");

    const provider = new DotNetMonitorProvider(log);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('dotnet-monitor-view', provider));

    vscode.debug.onDidStartDebugSession(() => {
        setTimeout(() => {
            provider.autoAttachProject();
            vscode.commands.executeCommand('dotnet-monitor-view.focus');
        }, 2000);
    });

    vscode.debug.onDidTerminateDebugSession(() => {
        provider.stop('DEBUG FINISHED');
    });
}

class DotNetMonitorProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _interval?: NodeJS.Timeout;
    private _psProcess?: ChildProcess;
    private _prevNet?: { rx: number; tx: number; ts: number; iface: string };
    private _prevDisk?: { w: number; r: number; ts: number };

    constructor(
        private readonly _log: vscode.OutputChannel
    ) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        const nonce = getNonce();

        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, nonce);

        webviewView.onDidDispose(() => this.stop('STOPPED'));
        
        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'changeProcess') {
                await this.promptForProcess();
            } else if (data.type === 'stop') {
                this.stop('STOPPED');
            }
        });

        this._view.webview.postMessage({ type: 'status', msg: 'Select a process' });
    }

    public stop(status: string) {
        if (this._interval) {clearInterval(this._interval);}
        this._interval = undefined;
        
        if (this._psProcess) {
            this._psProcess.kill();
            this._psProcess = undefined;
        }

        this._view?.webview.postMessage({ type: 'status', msg: status, clear: true });
    }

    public async startMonitoring(pid: number, name: string) {
        if (!this._view) {
            this._log.appendLine('No active webview to show metrics.');
            return;
        }
        this.stop('Changing process...');
        this._log.appendLine(`Monitoring PID: ${pid} (${name})`);

        this._view?.webview.postMessage({ type: 'status', msg: `LIVE · ${name} (PID ${pid})` });

        if (process.platform === 'win32') {
            const cores = os.cpus().length || 1;
            const psScript = `
$id = ${pid}
$lastR = 0; $lastW = 0; $lastO = 0; $lastT = 0
while($true) {
    try {
        $raw = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter "IDProcess=$id" -ErrorAction SilentlyContinue
        if ($raw) {
            $now = [DateTime]::UtcNow.Ticks
            if ($lastT -ne 0) {
                $dt = ($now - $lastT) / 10000000.0
                if ($dt -le 0) { $dt = 1 }
                
                $curR = [uint64]$raw.IOReadBytesPersec
                $curW = [uint64]$raw.IOWriteBytesPersec
                $curO = [uint64]$raw.IOOtherBytesPersec
                
                $disk = (($curR - $lastR) + ($curW - $lastW)) / $dt
                $net = ($curO - $lastO) / $dt
                
                $fmt = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess=$id" -ErrorAction SilentlyContinue
                if ($fmt) {
                    [Console]::WriteLine("$($fmt.PercentProcessorTime),$($fmt.WorkingSetPrivate),$disk,$net")
                }
                
                $lastR = $curR; $lastW = $curW; $lastO = $curO; $lastT = $now
            } else {
                $lastR = [uint64]$raw.IOReadBytesPersec
                $lastW = [uint64]$raw.IOWriteBytesPersec
                $lastO = [uint64]$raw.IOOtherBytesPersec
                $lastT = $now
            }
        } else {
            [Console]::WriteLine("dead")
        }
    } catch {
        [Console]::WriteLine("dead")
    }
    Start-Sleep -Milliseconds 600
}
`;
            this._psProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript]);
            
            if (!this._psProcess.stdout || !this._psProcess.stderr) {
                this.stop('TERMINAL ERROR');
                return;
            }

            const rl = readline.createInterface({ input: this._psProcess.stdout });
            rl.on('line', (line) => {
                if (line.trim() === 'dead') {
                    this._log.appendLine(`Process ${pid} has closed.`);
                    this.stop('PROCESS CLOSED');
                    return;
                }
                const parts = line.split(',');
                if (parts.length === 4) {
                    const cpuVal = Number(parts[0]) / cores; // Escalar por cores lógicos
                    const memVal = Number(parts[1]); // Working Set Private
                    const diskVal = Number(parts[2]); // File IO (Read + Write)
                    const netVal = Number(parts[3]); // Other IO (Network/Device)
                    
                    this._view?.webview.postMessage({
                        type: 'update',
                        cpu: Number(cpuVal.toFixed(1)),
                        mem: Number((memVal / 1024 / 1024).toFixed(1)),
                        disk: Number((diskVal / 1024 / 1024).toFixed(2)),
                        net: Number(((netVal * 8) / 1000000).toFixed(2)),
                        pid,
                        name: name.toUpperCase()
                    });
                }
            });

            this._psProcess.stderr.on('data', (err) => {
                this._log.appendLine("PS Err: " + err.toString());
            });

            return; 
        }

        this._interval = setInterval(async () => {
            try {
                let cpuVal = 0;
                let memVal = 0;
                try {
                    const stats = await pidusage(pid);
                    cpuVal = stats.cpu;
                    memVal = stats.memory;
                } catch (err: any) {
                    const procs = await si.processes();
                    const procObj = procs.list.find((p: any) => p.pid === pid);
                    if (procObj) {
                        cpuVal = procObj.cpu;
                        memVal = (procObj as any).memRss ? (procObj as any).memRss * 1024 : 0; 
                    } else {
                        throw err; 
                    }
                }
                const [netAdapters, diskIo] = await Promise.all([si.networkStats('*'), si.disksIO()]);

                const now = Date.now();
                const preferred = netAdapters.find((n: any) => !n.iface.toLowerCase().includes('loopback')) ?? netAdapters[0];

                let netRx = 0;
                if (preferred) {
                    const rx = preferred.rx_bytes ?? 0;
                    const tx = preferred.tx_bytes ?? 0;
                    if (this._prevNet && this._prevNet.iface === preferred.iface) {
                        const dt = Math.max(1, now - this._prevNet.ts) / 1000;
                        netRx = ((rx - this._prevNet.rx) * 8 / 1000000) / dt; // Mbps
                    }
                    this._prevNet = { rx, tx, ts: now, iface: preferred.iface };
                }

                const writeBytes = diskIo?.wIO ?? 0;
                let diskWrite = 0;
                if (this._prevDisk) {
                    const dt = Math.max(1, now - this._prevDisk.ts) / 1000;
                    diskWrite = (writeBytes - this._prevDisk.w) / 1024 / 1024 / dt; // MB/s
                }
                this._prevDisk = { w: writeBytes, r: diskIo?.rIO ?? 0, ts: now };

                this._view?.webview.postMessage({
                    type: 'update',
                    cpu: Number(cpuVal.toFixed(1)),
                    mem: Number((memVal / 1024 / 1024).toFixed(1)), // Private Bytes en Win
                    disk: Number(diskWrite.toFixed(2)),
                    net: Number(netRx.toFixed(1)),
                    pid,
                    name: name.toUpperCase()
                });
            } catch (e: any) {
                this._log.appendLine("Loop error: " + e.message);
                this.stop('ERR: ' + e.message.substring(0, 20));
            }
        }, 1000);
    }

    private async promptForProcess() {
        const input = await vscode.window.showInputBox({ prompt: "Enter PID or Name (e.g., dotnet)" });
        if (!input) {return;}

        try {
            const processesData = await si.processes();
            const processes = processesData.list;
            
            const num = parseInt(input);
            const isNum = !isNaN(num) && num.toString() === input;
            
            const proc = processes
                .filter((p: any) => (isNum && p.pid === num) || p.name.toLowerCase().includes(input.toLowerCase()))
                .sort((a: any, b: any) => (b.cpu ?? 0) - (a.cpu ?? 0))[0];

            if (proc) {
                this.startMonitoring(proc.pid, proc.name);
            } else {
                vscode.window.showWarningMessage(`No process found matching: ${input}`);
                this.stop('Not found');
            }
        } catch (error: any) {
            this._log.appendLine('Error listing processes: ' + error.message);
            this.stop('Error');
        }
    }

    public async autoAttachProject() {
        try {
            // Find csproj explicitly avoiding unused folders
            const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', '{**/node_modules/**,**/bin/**,**/obj/**}');
            let searchNames: string[] = [];
            
            if (csprojFiles.length > 0) {
                searchNames = csprojFiles.map(f => {
                    const fileName = f.path.split('/').pop() || '';
                    return fileName.replace('.csproj', '').toLowerCase();
                });
                this._log.appendLine("Auto-detecting based on projects: " + searchNames.join(', '));
            } else {
                this._log.appendLine("No csproj found. Falling back to 'dotnet'.");
                searchNames = ['dotnet'];
            }

            const processesData = await si.processes();
            const processes = processesData.list;
            
            const targetProcs = processes
                .filter((p: any) => {
                    const pName = p.name.toLowerCase();
                    // Avoid picking VS Code or itself
                    if (pName === 'code.exe' || pName === 'code') { return false; }
                    const pCmd = (p.command || '').toLowerCase();
                    
                    return searchNames.some(name => 
                        pName.includes(name) || (pName.includes('dotnet') && pCmd.includes(name + '.dll'))
                    );
                })
                .sort((a: any, b: any) => (b.cpu ?? 0) - (a.cpu ?? 0));

            if (targetProcs.length > 0) {
                this.startMonitoring(targetProcs[0].pid, targetProcs[0].name);
            } else {
                this._log.appendLine("No match found for csproj system name on debug start.");
            }
        } catch (error: any) {
            this._log.appendLine('Error auto-detecting project: ' + error.message);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview, nonce: string) {
        const csp = [
            "default-src 'none'",
            `style-src 'nonce-${nonce}' ${webview.cspSource}`,
            `script-src 'nonce-${nonce}' ${webview.cspSource}`,
            `img-src ${webview.cspSource} https:`,
            "connect-src https: ws:"
        ].join('; ');

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta http-equiv="Content-Security-Policy" content="${csp}">
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style nonce="${nonce}">
                * { box-sizing: border-box; }
                body {
                    background-color: transparent;
                    color: var(--vscode-foreground);
                    font-family: var(--vscode-font-family), sans-serif;
                    font-size: var(--vscode-font-size);
                    padding: 10px; margin: 0; overflow: hidden;
                    height: 100vh; display: flex; flex-direction: column; gap: 10px;
                }
                .header {
                    display: flex; justify-content: space-between; align-items: center;
                    padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border);
                    flex-shrink: 0;
                }
                .p-tag { 
                    color: var(--vscode-textLink-activeForeground); 
                    font-size: 11px; font-weight: bold; 
                    font-family: var(--vscode-editor-font-family), monospace; 
                }
                .controls { display: flex; gap: 6px; }
                .card {
                    flex: 1; display: flex; flex-direction: column; min-height: 0;
                    background: var(--vscode-editor-background);
                    padding: 8px 10px;
                    border: 1px solid var(--vscode-widget-border); 
                    border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.15);
                }
                .label-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
                .title { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;}
                .val { font-family: var(--vscode-editor-font-family), monospace; font-size: 14px; font-weight: bold; line-height: 1; }
                
                canvas { flex: 1; min-height: 0; width: 100% !important; margin-top: 2px; }
                
                .c-cpu { color: #d7ba7d; }
                .c-mem { color: #c586c0; }
                .c-disk { color: #569cd6; } 
                .c-net { color: #4ec9b0; }
                
                button { 
                    background: var(--vscode-button-secondaryBackground); 
                    color: var(--vscode-button-secondaryForeground); 
                    border: none; border-radius: 2px;
                    font-size: 10px; font-weight: 600; cursor: pointer; padding: 4px 10px; 
                    transition: background 0.2s;
                }
                button:hover { background: var(--vscode-button-secondaryHoverBackground); }
                #btn-stop { background: transparent; color: var(--vscode-errorForeground); }
                #btn-stop:hover { background: var(--vscode-toolbar-hoverBackground); }
            </style>
        </head>
        <body>
            <div class="header">
                <span id="p-n" class="p-tag">OFFLINE</span>
                <div class="controls">
                    <button id="btn-select">SELECT</button>
                    <button id="btn-stop">STOP</button>
                </div>
            </div>

            ${['CPU', 'MEM', 'DISK', 'NET'].map(m => `
                <div class="card">
                    <div class="label-row">
                        <span class="title">${m === 'MEM' ? 'PRIVATE' : m}</span>
                        <span id="${m.toLowerCase()}-v" class="val c-${m.toLowerCase()}">0</span>
                    </div>
                    <canvas id="${m.toLowerCase()}Chart"></canvas>
                </div>
            `).join('')}

            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                const send = (type) => vscode.postMessage({ type });
                document.getElementById('btn-select').addEventListener('click', () => send('changeProcess'));
                document.getElementById('btn-stop').addEventListener('click', () => send('stop'));
                
                const colors = { cpu: '#d7ba7d', mem: '#c586c0', disk: '#569cd6', net: '#4ec9b0' };
                
                class Sparkline {
                    constructor(id, color) {
                        this.canvas = document.getElementById(id + 'Chart');
                        this.ctx = this.canvas.getContext('2d');
                        this.color = color;
                        this.data = Array(30).fill(0);
                    }
                    
                    resize() {
                        const style = window.getComputedStyle(this.canvas);
                        const width = parseFloat(style.width);
                        const height = parseFloat(style.height);
                        const dpr = window.devicePixelRatio || 1;
                        
                        this.canvas.width = width * dpr;
                        this.canvas.height = height * dpr;
                        this.ctx.scale(dpr, dpr);
                        this.draw();
                    }
                    
                    push(val) {
                        this.data.shift();
                        this.data.push(val);
                        this.draw();
                    }
                    
                    draw() {
                        const ctx = this.ctx;
                        const w = this.canvas.width / (window.devicePixelRatio || 1);
                        const h = this.canvas.height / (window.devicePixelRatio || 1);
                        
                        ctx.clearRect(0, 0, w, h);
                        
                        let maxVal = Math.max(...this.data) * 1.2; // 20% top margin (Chartjs style)
                        if (maxVal === 0) {maxVal = 1;} // Prevent division by 0
                        
                        const padLeft = 26; // Shifted left to optimize space
                        const padBot = 10;
                        const padTop = 10;
                        const graphW = w - padLeft;
                        const graphH = h - padTop - padBot;
                        
                        // Draw grid and Y ticks
                        const docStyle = window.getComputedStyle(document.documentElement);
                        ctx.fillStyle = docStyle.getPropertyValue('--vscode-foreground').trim() || '#cccccc'; 
                        ctx.font = '10px var(--vscode-editor-font-family), monospace';
                        ctx.textAlign = 'right';
                        ctx.textBaseline = 'middle';
                        
                        ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)'; // Líneas sutiles
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        
                        const ticks = [0, maxVal / 2, maxVal];
                        ticks.forEach((tick, i) => {
                            const y = padTop + graphH - ((tick / maxVal) * graphH);
                            let tStr = tick;
                            if (tick >= 10) {tStr = Math.round(tick).toString();}
                            else if (tick > 0) {tStr = tick.toFixed(1);}
                            else {tStr = '0';}
                            
                            ctx.fillText(tStr, padLeft - 8, y);
                            
                            // Dibuja las líneas horizontales en toda la gráfica (estilo Chart.js)
                            ctx.moveTo(padLeft, y);
                            ctx.lineTo(w, y);
                        });
                        ctx.stroke();
                        
                        // Calcula las coordenadas de los puntos
                        const stepX = graphW / (this.data.length - 1);
                        const pts = this.data.map((val, i) => ({
                            x: padLeft + i * stepX,
                            y: padTop + graphH - ((val / maxVal) * graphH)
                        }));
                        
                        // Gradiente de relleno (Efecto Chart.js)
                        const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + graphH);
                        gradient.addColorStop(0, this.color + '80'); // 50% opacidad arriba
                        gradient.addColorStop(1, this.color + '00'); // Trasparente abajo
                        
                        ctx.beginPath();
                        ctx.moveTo(pts[0].x, padTop + graphH); // Empezar en la esquina inferior izquierda
                        
                        // Curvas suaves (simuladas con líneas pero con lineJoin round)
                        pts.forEach((p, i) => {
                            ctx.lineTo(p.x, p.y);
                        });
                        
                        ctx.lineTo(pts[pts.length-1].x, padTop + graphH); // Esquina inferior derecha
                        ctx.closePath();
                        
                        ctx.fillStyle = gradient;
                        ctx.fill();
                        
                        // Línea principal
                        ctx.beginPath();
                        ctx.moveTo(pts[0].x, pts[0].y);
                        pts.forEach(p => ctx.lineTo(p.x, p.y));
                        
                        ctx.strokeStyle = this.color;
                        ctx.lineWidth = 2; // Línea más gruesa y vistosa
                        ctx.lineJoin = 'round';
                        ctx.lineCap = 'round';
                        ctx.stroke();
                        
                        // Puntos (Dots) en el último valor
                        const lastPt = pts[pts.length - 1];
                        ctx.beginPath();
                        ctx.arc(lastPt.x, lastPt.y, 3, 0, Math.PI * 2);
                        ctx.fillStyle = this.color;
                        ctx.fill();
                        ctx.strokeStyle = 'var(--vscode-editor-background)';
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                }
                
                const charts = {};
                ['cpu', 'mem', 'disk', 'net'].forEach(id => {
                    charts[id] = new Sparkline(id, colors[id]);
                });
                
                const resizer = new ResizeObserver(() => {
                    Object.values(charts).forEach(c => c.resize());
                });
                document.querySelectorAll('canvas').forEach(c => resizer.observe(c));

                const updateStatus = (text) => document.getElementById('p-n').innerText = text;

                window.addEventListener('message', e => {
                    const d = e.data;
                    if(d.type === 'status') { 
                        updateStatus(d.msg); 
                        if (d.clear) {
                            ['cpu', 'mem', 'disk', 'net'].forEach(id => {
                                document.getElementById(id+'-v').innerText = '0';
                                charts[id].data = Array(30).fill(0);
                                charts[id].draw();
                            });
                        }
                        return; 
                    }
                    updateStatus(d.name ?? 'LIVE');
                    const up = (k, v, u) => {
                        document.getElementById(k+'-v').innerText = v + u;
                        charts[k].push(Number(v));
                    };
                    up('cpu', Number(d.cpu).toFixed(1), '%');
                    up('mem', Number(d.mem).toFixed(1), 'MB');
                    up('disk', Number(d.disk).toFixed(2), 'MB/s');
                    up('net', Number(d.net).toFixed(2), 'Mbps');
                });
            </script>
        </body>
        </html>`;
    }
}