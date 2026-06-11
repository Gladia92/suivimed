; installer.nsh — inclus par electron-builder dans le script NSIS.
; Importe le certificat public XYVEL Medical dans les magasins de confiance
; de l'UTILISATEUR courant (pas besoin d'admin), pour que l'application
; signée n'apparaisse plus comme "éditeur inconnu" sur le PC cible.
;
; Le fichier XyvelMedical.cer est embarqué via "extraResources" (package.json)
; et se retrouve dans $INSTDIR\resources\XyvelMedical.cer.
; Certificat PARTAGÉ par tout le pack XYVEL Medical (même éditeur).

!macro customInstall
  ; -user : magasin de l'utilisateur courant -> aucune élévation requise
  ; Root  : rend la chaîne de signature valide (plus d'avertissement éditeur)
  ; TrustedPublisher : évite l'invite SmartScreen/UAC pour cet éditeur
  nsExec::Exec 'certutil -user -addstore -f "Root" "$INSTDIR\resources\XyvelMedical.cer"'
  nsExec::Exec 'certutil -user -addstore -f "TrustedPublisher" "$INSTDIR\resources\XyvelMedical.cer"'
!macroend

!macro customUnInstall
  ; On NE retire PAS le certificat à la désinstallation : sinon, une réinstallation
  ; (mise à jour) réafficherait "éditeur inconnu" tant que l'installeur n'a pas
  ; réimporté le certificat — or ce prompt s'affiche AVANT l'installation.
  ; Garder le certificat de confiance est sans danger (éditeur du pack XYVEL).
!macroend
