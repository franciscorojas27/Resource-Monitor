const fs = require('fs');
let c = fs.readFileSync('src/extension.ts', 'utf8');

const translations = [
    [/Extension Iniciada/g, "Extension Started"],
    [/DEBUG TERMINADO/g, "DEBUG FINISHED"],
    [/DETENIDO/g, "STOPPED"],
    [/Selecciona un proceso/g, "Select a process"],
    [/Cambiando proceso\.\.\./g, "Changing process..."],
    [/Monitoreando PID:/g, "Monitoring PID:"],
    [/No hay webview activo para mostrar métricas\./g, "No active webview to show metrics."],
    [/ERROR DE TERMINAL/g, "TERMINAL ERROR"],
    [/El proceso \$\{pid\} se ha cerrado\./g, "Process ${pid} has closed."],
    [/PROCESO CERRADO/g, "PROCESS CLOSED"],
    [/Error en loop:/g, "Loop error:"],
    [/Ingresa PID o Nombre \(ej: dotnet\)/g, "Enter PID or Name (e.g., dotnet)"],
    [/No se encontró ningún proceso que coincida con:/g, "No process found matching:"],
    [/No encontrado/g, "Not found"],
    [/Error al listar procesos:/g, "Error listing processes:"],
    [/No se encontró ningún proceso 'dotnet' al iniciar el debug\./g, "No 'dotnet' process found on debug start."],
    [/Error autodetectando dotnet:/g, "Error auto-detecting dotnet:"]
];

translations.forEach(([regex, replacement]) => {
    c = c.replace(regex, replacement);
});

fs.writeFileSync('src/extension.ts', c);
console.log('Translations applied successfully!');