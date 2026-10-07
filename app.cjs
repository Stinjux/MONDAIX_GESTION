// Point d'entrée de l'application (npm start, Docker, cPanel « Setup Node.js App » / Passenger).
// Fichier CommonJS pour rester compatible avec les chargeurs qui utilisent require().
import('./src/demarrer.js')
  .then(({ demarrer }) => demarrer())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
