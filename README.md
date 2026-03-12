# .NET Monitor Gráfico

Panel ligero para observar CPU, memoria privada, escritura a disco y tráfico de red de un proceso .NET desde la barra lateral de VS Code.

## Uso rápido
- Abre la vista “.NET Monitor” en la barra lateral. La extensión se activa al abrirla.
- Pulsa “Seleccionar proceso” y elige cualquier proceso (suele aparecer `dotnet`).
- El tablero se pone en estado `LIVE` y actualiza métricas cada segundo; puedes pulsar “Detener” cuando quieras.

## Notas técnicas
- Lecturas de CPU/memoria se realizan con `pidusage`; disco y red son métricas de sistema con `systeminformation`.
- Si no hay métricas disponibles, se muestra un estado de error en la vista y se detiene el bucle.

## Scripts
- `pnpm run watch` – compila en modo watch.
- `pnpm run test` – ejecuta pruebas con `@vscode/test-electron` (requiere build previa generada por los scripts en `pretest`).

## Requisitos
- VS Code 1.110.0 o superior.
- Permisos para leer procesos del sistema donde se ejecuta VS Code.
