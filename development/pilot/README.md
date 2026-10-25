# Piloto de especialistas para desarrollo AETHER

Este directorio contiene tres perfiles adaptados de Agency Agents y un preparador local de tareas. Se usa desde una sesión de desarrollo existente; no registra agentes operativos, no agrega un servicio, no requiere Hermes y no ejecuta modelos.

## Uso

```sh
node development/pilot/prepare-task.mjs backend "Definir el contrato de una función nueva" < contexto.txt
node development/pilot/prepare-task.mjs frontend "Revisar la presentación de los resultados" < contexto.txt
node development/pilot/prepare-task.mjs reviewer "Revisar el diff y las pruebas" < contexto.txt
```

La salida JSON contiene el prompt del perfil elegido y su referencia de origen. El desarrollador utiliza ese prompt en su ejecutor autorizado. La herramienta no envía la salida a ningún destino. No incluyas secretos ni datos reales de clientes: el contexto se reproduce en stdout. Para contexto vacío en una terminal interactiva, omite la redirección.

## Selección y límites

| Perfil | Responsabilidad | Entrega |
| --- | --- | --- |
| backend | Arquitectura, contratos y lógica | Cambio mínimo, errores y validación |
| frontend | Interfaz y presentación | Estados claros, teclado y adaptación de pantalla cuando exista UI |
| reviewer | Corrección y regresiones | Hallazgos demostrables y límites de la revisión |

Se elige un perfil por invocación. No hay selección automática, delegación, reintentos ni historial residente. El contexto acepta 12000 caracteres y la tarea 4000; son límites de caracteres, no tokens. Preparar el paquete hace cero llamadas a modelos. Ejecutar posteriormente el prompt consume según el ejecutor y modelo usados; no se promete ahorro porcentual ni costo cero del trabajo de IA.

Las instrucciones son guías, no controles de permisos. Las autorizaciones deben seguir aplicándose en el ejecutor y el backend. Una revisión por el mismo asistente no es revisión independiente. Ningún perfil autoriza merge o despliegue.

## Encaje con lo existente

La revisión de código fuente identificó perfiles operativos de coordinación, fiabilidad, inteligencia, ingresos y cumplimiento en DOS. No se modificaron ni se invocaron. El mandato de arquitectura de AETHER establece que DOS no puede ser una dependencia crítica: cualquier telemetría compartida debe ser opcional. Estos perfiles de desarrollo tampoco dependen de DOS.

Este repo contiene un componente de voz de AETHER, no toda la plataforma. El piloto vive como herramienta de desarrollo aislada; no se importa desde `index.mjs`, no cambia prompts de Valentina ni rutas de llamadas. Los perfiles se pueden copiar con su manifiesto y licencia a otros repos de AETHER después de revisar las convenciones de cada proyecto. No se han instalado en la aplicación Base44 ni en nodos Hermes.

## Procedencia

Adaptaciones al español de `msitarzewski/agency-agents`, rutas y blobs fijados en `profiles.json`. La adaptación elimina ejemplos y objetivos numéricos no medidos. Se incluye el texto MIT original en `THIRD_PARTY_LICENSE.txt`. Las actualizaciones son manuales y revisables, sin descargar instrucciones cambiantes en tiempo de ejecución.

## Validación

```sh
node --check development/pilot/prepare-task.mjs
node --test development/pilot/prepare-task.test.mjs
npm run check
npm test
```

Las pruebas verifican selección individual, rechazo de perfiles inválidos y traversal, límites de entrada, CLI independiente del directorio y texto en español. Los tests de voz existentes usan mocks; no constituyen validación telefónica en producción.
