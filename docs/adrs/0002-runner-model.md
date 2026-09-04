# ADR 0002: Runner local con templates aprobados

## Estado

Aceptado.

## Contexto

Los cinco proyectos no comparten stack. Un comando universal generaria falsos positivos o fallas confusas.

## Decision

El MVP detecta comandos por stack y solo permite acciones mapeadas a templates aprobados. Se usa `spawn` con `shell: false`.

## Consecuencias

- El navegador no manda comandos libres.
- Un proyecto sin scripts queda como brecha del Doctor.
- Los runners especializados por stack pueden agregarse sin cambiar el contrato del frontend.
